import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { resolveClientScopes } from "../utils/scope";
import { writeAudit } from "../utils/audit";

/**
 * Remote device configuration / control (Teltonika Codec 12).
 *
 * Commands are queued locally, then handed to the MeshSat relay's `/api/cmd`
 * endpoint (meshsat.dspng.space) which delivers them to the tracker over its
 * next TCP session (5027). Delivery is therefore asynchronous: a queued
 * command shows as "Queued / Pending Next Tracker Sync" until the tracker's
 * next sync.
 */
const router = Router();
router.use(requireAuth);

const MESHSAT_CMD_URL = (process.env.MESHSAT_CMD_URL || "https://meshsat.dspng.space").replace(/\/$/, "");
const MESHSAT_CMD_TOKEN = process.env.MESHSAT_CMD_TOKEN || "";

/** Roles permitted to dispatch device commands (client-role users are excluded). */
const COMMAND_ROLES = ["admin", "fleet_admin", "fleet_manager"];

const commandSchema = z.object({
  imei: z.string().min(1),
  type: z.enum(["setparam", "setdigout", "raw"]),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().default({}),
});

export interface BuiltCommand {
  command?: Record<string, unknown>;
  error?: string;
}

/**
 * Builds the concrete Codec-12 command from a validated request. `setparam`
 * requires a parameter resolvable through `param_map` (by `param_id` or
 * `feature_key`); `setdigout` requires a 0/1 DOUT state.
 */
export function buildCommand(type: "setparam" | "setdigout" | "raw", params: Record<string, string | number | boolean>): BuiltCommand {
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
    return { command: { type: "setdigout", dout } };
  }

  if (typeof params.command !== "string" || !params.command) return { error: "raw requires a 'command' string" };
  return { command: { type: "raw", command: params.command } };
}

/** Hands a command to the MeshSat relay for delivery to the tracker's TCP session. */
export async function forwardCommand(imei: string, command: Record<string, unknown>) {
  const res = await fetch(`${MESHSAT_CMD_URL}/api/cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cmd-token": MESHSAT_CMD_TOKEN,
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

    const id = uuid();
    db.prepare(`
      INSERT INTO device_commands (id, imei, vehicle_id, command_type, payload_json, status, requested_by)
      VALUES (?, ?, ?, ?, ?, 'queued', ?)
    `).run(id, imei, device.vehicle_id, type, JSON.stringify(built.command), req.user!.id);

    writeAudit({
      userId: req.user!.id,
      action: "DEVICE_COMMAND_QUEUED",
      entity: "device_commands",
      entityId: id,
      newValue: { imei, type, params },
    });

    // Forward to the MeshSat relay. A relay rejection is terminal ('failed');
    // an unreachable relay leaves the row 'queued' for a later retry.
    let status = "queued";
    let sentAt: string | null = null;
    let responseText: string | null = null;
    try {
      const result = await forwardCommand(imei, built.command);
      responseText = (result.text || "").slice(0, 1000) || null;
      if (result.ok) {
        status = "sent";
        sentAt = new Date().toISOString().replace("T", " ").substring(0, 19);
      } else {
        status = "failed";
      }
    } catch (err: any) {
      responseText = `Relay unreachable: ${err?.message ?? String(err)}`;
      status = "queued";
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
