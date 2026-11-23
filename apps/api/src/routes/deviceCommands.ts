import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { requireAuth, requireIngestToken } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { resolveClientScopes } from "../utils/scope";
import { writeAudit } from "../utils/audit";

/**
 * Remote device configuration / control (Teltonika Codec 12).
 *
 * Commands are queued locally, then handed to the MeshSat VPS command endpoint
 * (meshsat.dspng.space `/api/cmd`), which queues them and delivers them to the
 * tracker over its next TCP session (5027). Delivery is therefore asynchronous:
 * a command shows as "Queued / Pending Next Tracker Sync" until the tracker's
 * next sync.
 */
const router = Router();

/**
 * POST /api/telemetry/commands/ack
 *
 * Tracker-reply callback. The MeshSat VPS calls this when the FMB125 answers a
 * queued command over Codec 12, authenticated with the same
 * `Authorization: Bearer ${TELEMETRY_INGEST_TOKEN}` used by `/ingest`.
 *
 * Body: `{ imei, command | cmd, response | reply }`, where `command`/`cmd` is
 * the Teltonika command string the tracker acknowledged (e.g. `setparam 1580:80`)
 * and `response`/`reply` is the tracker's raw reply text.
 *
 * The most recent `device_commands` row for that imei with status `sent` whose
 * serialized command matches is marked `acknowledged` (storing `response_text`
 * and `acked_at`). Returns 200 with the updated row, or 404 when no sent
 * command matches. Registered before `requireAuth` — this path uses the ingest
 * bearer token, not a user JWT.
 */
router.post("/ack", requireIngestToken, (req, res, next) => {
  try {
    const parsed = ackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid ack payload", details: parsed.error.flatten() });
    }
    const { imei } = parsed.data;
    const command = (parsed.data.command ?? parsed.data.cmd ?? "").trim();
    const reply = parsed.data.response ?? parsed.data.reply ?? null;

    const rows = db
      .prepare("SELECT id, payload_json FROM device_commands WHERE imei = ? AND status = 'sent' ORDER BY created_at DESC")
      .all(imei) as { id: string; payload_json: string | null }[];

    const match = rows.find((row) => {
      if (!row.payload_json) return false;
      try {
        return serializeCommand(JSON.parse(row.payload_json)).trim() === command;
      } catch {
        return false;
      }
    });
    if (!match) return res.status(404).json({ error: "No matching sent command", imei, command });

    const ackedAt = new Date().toISOString().replace("T", " ").substring(0, 19);
    db.prepare("UPDATE device_commands SET status = 'acknowledged', response_text = ?, acked_at = ? WHERE id = ?")
      .run(reply, ackedAt, match.id);

    res.json({
      data: db.prepare("SELECT * FROM device_commands WHERE id = ?").get(match.id),
      message: "Command acknowledged",
    });
  } catch (e) {
    next(e);
  }
});

router.use(requireAuth);

/** Roles permitted to dispatch device commands (client-role users are excluded). */
const COMMAND_ROLES = ["admin", "fleet_manager"];

/**
 * Read-only status commands the FMB125 accepts. Only these exact strings may be
 * issued through the `diagnostic` type; arbitrary strings must go through `raw`.
 */
const DIAGNOSTIC_COMMANDS = new Set(["getinfo", "getgps", "getver", "getstatus"]);

/**
 * Speed above which an ignition cut (setdigout 1) is refused: immobilising a
 * moving vehicle is unsafe. Overridable only by an `admin` that explicitly
 * passes `force: true` (which is audited as IGNITION_CUT_FORCED).
 */
export const IGNITION_CUT_SPEED_LIMIT_KMH = 10;

const commandSchema = z.object({
  imei: z.string().min(1),
  type: z.enum(["setparam", "setdigout", "diagnostic", "raw"]),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().default({}),
  /** Admin-only override of the moving-vehicle ignition-cut guard. */
  force: z.boolean().optional(),
  /** Operator-supplied justification; required for an ignition cut. */
  reason: z.string().optional(),
});

/** Body contract for the tracker-ack callback (POST /ack). */
const ackSchema = z.object({
  imei: z.string().min(1),
  command: z.string().min(1).optional(),
  cmd: z.string().min(1).optional(),
  response: z.string().optional(),
  reply: z.string().optional(),
});

export interface BuiltCommand {
  command?: Record<string, unknown>;
  error?: string;
}

/**
 * Builds the concrete Codec-12 command from a validated request. `setparam`
 * requires a parameter resolvable through `param_map` (by `param_id` or
 * `feature_key`); `setdigout` requires a 0/1 DOUT state (with an optional
 * non-negative `timeout`); `diagnostic` requires a whitelisted status command.
 */
export function buildCommand(
  type: "setparam" | "setdigout" | "diagnostic" | "raw",
  params: Record<string, string | number | boolean>
): BuiltCommand {
  if (type === "setparam") {
    let paramId = typeof params.param_id === "number" ? params.param_id : undefined;
    if (paramId === undefined && typeof params.feature_key === "string") {
      const row = db.prepare("SELECT param_id FROM param_map WHERE feature_key = ? LIMIT 1").get(params.feature_key) as { param_id: number } | undefined;
      paramId = row?.param_id;
    }
    if (paramId === undefined) return { error: "Unknown parameter: supply a mapped param_id or feature_key" };
    if (params.value === undefined) return { error: "setparam requires a 'value'" };
    return { command: { type: "setparam", param_id: paramId, value: params.value } };
  }

  if (type === "setdigout") {
    const raw = params.dout ?? params.dout1 ?? params.state;
    if (raw === undefined) return { error: "setdigout requires 'dout' (0 or 1)" };
    const dout = Number(raw);
    if (dout !== 0 && dout !== 1) return { error: "setdigout 'dout' must be 0 or 1" };
    const command: Record<string, unknown> = { type: "setdigout", dout };
    // Optional DOUT pulse timeout (milliseconds). Absent → the backward-
    // compatible `setdigout <dout>` form; present → `setdigout <dout> <timeout>`.
    if (params.timeout !== undefined && params.timeout !== null && params.timeout !== "") {
      const timeout = Number(params.timeout);
      if (!Number.isInteger(timeout) || timeout < 0) return { error: "setdigout 'timeout' must be a non-negative integer" };
      command.timeout = timeout;
    }
    return { command };
  }

  if (type === "diagnostic") {
    const cmd = params.command;
    if (typeof cmd !== "string" || !DIAGNOSTIC_COMMANDS.has(cmd)) {
      return { error: `diagnostic requires a 'command' of: ${[...DIAGNOSTIC_COMMANDS].join(", ")}` };
    }
    return { command: { type: "diagnostic", command: cmd } };
  }

  if (typeof params.command !== "string" || !params.command) return { error: "raw requires a 'command' string" };
  return { command: { type: "raw", command: params.command } };
}

/**
 * Serializes a built command into the Teltonika command string the VPS
 * forwards over Codec 12 (e.g. `setparam 1580:80`, `setdigout 1`,
 * `setdigout 1 30000`, `getgps`).
 */
export function serializeCommand(command: Record<string, unknown>): string {
  switch (command.type) {
    case "setparam":
      return `setparam ${command.param_id}:${command.value}`;
    case "setdigout":
      return command.timeout !== undefined && command.timeout !== null
        ? `setdigout ${command.dout} ${command.timeout}`
        : `setdigout ${command.dout}`;
    case "diagnostic":
    case "raw":
      return String(command.command);
    default:
      return JSON.stringify(command);
  }
}

/**
 * Most recent reported speed (km/h) for a vehicle, from the rich
 * `telemetry_records` table when available and otherwise the legacy
 * `gps_positions` table. `null` when the vehicle has never reported a fix.
 */
export function latestSpeedKmh(vehicleId: string): number | null {
  const t = db
    .prepare("SELECT speed_kmh FROM telemetry_records WHERE vehicle_id = ? AND speed_kmh IS NOT NULL ORDER BY recorded_at DESC LIMIT 1")
    .get(vehicleId) as { speed_kmh: number } | undefined;
  if (t?.speed_kmh !== undefined && t?.speed_kmh !== null) return Number(t.speed_kmh);

  const p = db
    .prepare("SELECT speed FROM gps_positions WHERE vehicle_id = ? ORDER BY recorded_at DESC LIMIT 1")
    .get(vehicleId) as { speed: number } | undefined;
  return p?.speed !== undefined && p?.speed !== null ? Number(p.speed) : null;
}

/**
 * Hands a command to the MeshSat VPS command endpoint
 * (`POST ${MESHSAT_CMD_URL}/api/cmd`), authenticated with
 * `Authorization: Bearer ${MESHSAT_CMD_TOKEN}`. Both env vars are read at call
 * time so they can be configured (Coolify) without a rebuild.
 *
 * Payload contract: `{ "imei": "<15-digit>", "command": "<teltonika-cmd>" }`.
 * The VPS also accepts `cmd` as a fallback key — we always send `command`.
 */
export async function forwardCommand(imei: string, command: string) {
  const baseUrl = (process.env.MESHSAT_CMD_URL || "https://meshsat.dspng.space").replace(/\/$/, "");
  const token = process.env.MESHSAT_CMD_TOKEN || "";
  const res = await fetch(`${baseUrl}/api/cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ imei, command }),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, text };
}

/**
 * POST /api/telemetry/commands
 * Queue a remote command for a device. Requires an elevated role and that the
 * device's vehicle belongs to a client the user may manage.
 */
router.post("/", requireRole(...COMMAND_ROLES), async (req, res, next) => {
  try {
    const parsed = commandSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid command", details: parsed.error.flatten() });
    const { imei, type, params } = parsed.data;
    const reason = (parsed.data.reason ?? "").trim() || null;

    const device = db
      .prepare("SELECT id, vehicle_id, client_id FROM gps_devices WHERE device_identifier = ?")
      .get(imei) as { id: string; vehicle_id: string | null; client_id: string | null } | undefined;
    if (!device) return res.status(404).json({ error: "Unknown device", details: `No gps_device registered for IMEI '${imei}'` });
    if (!device.vehicle_id) return res.status(400).json({ error: "Device not bound to a vehicle" });

    const scope = resolveClientScopes(req.user);
    if (scope && (!device.client_id || !scope.includes(device.client_id))) {
      return res.status(403).json({ error: "Forbidden: device is outside your client scope" });
    }

    const built = buildCommand(type, params);
    if (!built.command) return res.status(400).json({ error: "Invalid command parameters", details: built.error });

    // Ignition-cut safety guard (setdigout 1). An ignition cut requires an
    // operator-supplied reason, and is refused while the vehicle is moving
    // (> IGNITION_CUT_SPEED_LIMIT_KMH) unless an admin explicitly forces it.
    const isIgnitionCut = type === "setdigout" && built.command.dout === 1;
    let forcedOverride = false;
    let cutSpeedKmh: number | null = null;
    if (isIgnitionCut) {
      if (!reason) {
        return res.status(400).json({ error: "A reason is required for an ignition cut", details: "Supply a non-empty 'reason'" });
      }
      cutSpeedKmh = latestSpeedKmh(device.vehicle_id);
      if (cutSpeedKmh !== null && cutSpeedKmh > IGNITION_CUT_SPEED_LIMIT_KMH) {
        const canForce = req.user!.roleName === "admin" && parsed.data.force === true;
        if (!canForce) {
          return res.status(409).json({ error: "Vehicle moving — ignition cut blocked", speed_kmh: cutSpeedKmh });
        }
        forcedOverride = true;
      }
    }

    const id = uuid();
    db.prepare(`
      INSERT INTO device_commands (id, imei, vehicle_id, command_type, payload_json, status, requested_by, reason)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, imei, device.vehicle_id, type, JSON.stringify(built.command), req.user!.id, reason);

    const serialized = serializeCommand(built.command);

    // Immobilizer events get a distinct audit action so ignition cut/restore is
    // auditable on its own; every other command keeps DEVICE_COMMAND_QUEUED.
    const auditAction = type === "setdigout"
      ? (built.command.dout === 1 ? "IGNITION_CUT_QUEUED" : "IGNITION_RESTORE_QUEUED")
      : "DEVICE_COMMAND_QUEUED";

    writeAudit({
      userId: req.user!.id,
      action: auditAction,
      entity: "device_commands",
      entityId: id,
      newValue: { imei, vehicle_id: device.vehicle_id, command: serialized, type, params, reason },
    });

    // A forced override of the moving-vehicle guard is logged distinctly so the
    // override (and the speed/reason behind it) is auditable on its own.
    if (forcedOverride) {
      writeAudit({
        userId: req.user!.id,
        action: "IGNITION_CUT_FORCED",
        entity: "device_commands",
        entityId: id,
        newValue: { imei, vehicle_id: device.vehicle_id, command: serialized, speed_kmh: cutSpeedKmh, reason, forced: true },
      });
    }

    // Forward to the MeshSat VPS command endpoint. A 2xx means the command was
    // accepted for delivery ('sent'); any rejection or transport failure is
    // terminal ('failed') and the error is recorded for the operator.
    let status = "queued";
    let sentAt: string | null = null;
    let responseText: string | null = null;
    try {
      const result = await forwardCommand(imei, serialized);
      responseText = (result.text || "").slice(0, 1000) || null;
      if (result.ok) {
        status = "sent";
        sentAt = new Date().toISOString().replace("T", " ").substring(0, 19);
      } else {
        status = "failed";
        responseText = responseText || `Command endpoint returned HTTP ${result.status}`;
      }
    } catch (err: any) {
      responseText = `Command endpoint unreachable: ${err?.message ?? String(err)}`;
      status = "failed";
    }

    db.prepare("UPDATE device_commands SET status = ?, sent_at = ?, response_text = ? WHERE id = ?").run(status, sentAt, responseText, id);

    res.status(201).json({
      data: db.prepare("SELECT * FROM device_commands WHERE id = ?").get(id),
      message: "Queued / Pending Next Tracker Sync",
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/telemetry/commands?imei=
 * Queue + delivery history, tenant-scoped.
 */
router.get("/", (req, res, next) => {
  try {
    const scope = resolveClientScopes(req.user);
    const imei = req.query.imei as string | undefined;
    const params: any[] = [];
    let sql = `
      SELECT dc.*, v.vehicle_number, v.client_id
      FROM device_commands dc
      LEFT JOIN vehicles v ON v.id = dc.vehicle_id
      WHERE 1 = 1
    `;
    if (imei) {
      sql += " AND dc.imei = ?";
      params.push(imei);
    }
    if (scope) {
      sql += ` AND v.client_id IN (${scope.map(() => "?").join(", ")})`;
      params.push(...scope);
    }
    sql += " ORDER BY dc.created_at DESC LIMIT 200";
    res.json({ data: db.prepare(sql).all(...params) });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/telemetry/commands/:id/cancel
 * Cancels a still-queued command (marks it failed with a reason).
 */
router.post("/:id/cancel", requireRole(...COMMAND_ROLES), (req, res, next) => {
  try {
    const row = db.prepare("SELECT * FROM device_commands WHERE id = ?").get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: "Command not found" });

    const scope = resolveClientScopes(req.user);
    const device = db.prepare("SELECT client_id FROM gps_devices WHERE device_identifier = ?").get(row.imei) as { client_id: string | null } | undefined;
    if (scope && (!device?.client_id || !scope.includes(device.client_id))) {
      return res.status(403).json({ error: "Forbidden: device is outside your client scope" });
    }
    if (row.status !== "queued") {
      return res.status(409).json({ error: "Only queued commands can be cancelled", status: row.status });
    }

    db.prepare("UPDATE device_commands SET status = 'failed', response_text = 'Cancelled by user before dispatch' WHERE id = ?").run(req.params.id);
    writeAudit({ userId: req.user!.id, action: "DEVICE_COMMAND_CANCELLED", entity: "device_commands", entityId: req.params.id, previousValue: row });
    res.json({ data: db.prepare("SELECT * FROM device_commands WHERE id = ?").get(req.params.id), message: "Command cancelled" });
  } catch (e) {
    next(e);
  }
});

export default router;
