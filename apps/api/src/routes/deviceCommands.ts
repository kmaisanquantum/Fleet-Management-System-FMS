import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireIngestToken } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { resolveClientScopes } from "../utils/scope";
import { writeAudit } from "../utils/audit";
import { applyConfigAck, parseTrackerReply, ConfigValue } from "../services/deviceConfig";
import {
  buildCommand,
  COMMAND_ROLES,
  commandAuditAction,
  dispatchDeviceCommand,
  IGNITION_CUT_SPEED_LIMIT_KMH,
  latestSpeedKmh,
  normalizeCommandStatus,
  serializeCommand,
} from "../services/deviceCommands";

/**
 * Remote device configuration / control (Teltonika Codec 12).
 *
 * Commands are queued locally, then handed to the MeshSat Teltonika bridge
 * (`POST ${MESHSAT_BRIDGE_URL}/api/devices/:imei/command`), which delivers
 * them to the tracker over its next TCP session (5027). Delivery is therefore
 * asynchronous: a command shows as queued/sent until the tracker's reply
 * arrives on the ack callback.
 */
const router = Router();

export { buildCommand, COMMAND_ROLES, IGNITION_CUT_SPEED_LIMIT_KMH, serializeCommand } from "../services/deviceCommands";
export { forwardCommand } from "../services/deviceCommands";

/** Body contract for the tracker-ack callback (POST /ack). */
const ackSchema = z.object({
  imei: z.string().min(1),
  command: z.string().min(1).optional(),
  cmd: z.string().min(1).optional(),
  response: z.string().optional(),
  reply: z.string().optional(),
});

/**
 * POST /api/telemetry/commands/ack
 *
 * Tracker-reply callback. The MeshSat bridge calls this when the FMB125
 * answers a queued command over Codec 12, authenticated with the same
 * `Authorization: Bearer ${TELEMETRY_INGEST_TOKEN}` used by `/ingest`.
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
      .prepare("SELECT id, payload_json, raw_command FROM device_commands WHERE imei = ? AND status IN ('sent', 'queued') ORDER BY created_at DESC")
      .all(imei) as { id: string; payload_json: string | null; raw_command: string | null }[];

    const match = rows.find((row) => {
      if (row.raw_command && row.raw_command.trim() === command) return true;
      if (!row.payload_json) return false;
      try {
        return serializeCommand(JSON.parse(row.payload_json)).trim() === command;
      } catch {
        return false;
      }
    });
    if (!match) return res.status(404).json({ error: "No matching sent command", imei, command });

    const ackedAt = new Date().toISOString().replace("T", " ").substring(0, 19);
    const trackerReply = parseTrackerReply(reply);
    const status = trackerReply.status === "failed" ? "failed" : "applied";
    db.prepare(`
      UPDATE device_commands
      SET status = ?, response_text = ?, response_payload = ?, acked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, reply, reply, ackedAt, ackedAt, match.id);

    const commandRow = db.prepare("SELECT * FROM device_commands WHERE id = ?").get(match.id) as any;
    applyConfigAck(commandRow, reply);

    res.json({
      data: { ...commandRow, status: normalizeCommandStatus(commandRow.status) },
      message: trackerReply.status === "failed" ? "Command failed" : "Command acknowledged",
    });
  } catch (e) {
    next(e);
  }
});

router.use(requireAuth);

const commandSchema = z.object({
  imei: z.string().min(1),
  type: z.enum(["setparam", "setdigout", "diagnostic", "raw", "camreq"]),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().default({}),
  /** Admin-only override of the moving-vehicle ignition-cut guard. */
  force: z.boolean().optional(),
  /** Operator-supplied justification; required for an ignition cut. */
  reason: z.string().optional(),
});

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

    const configState = type === "setparam"
      ? {
          paramId: Number(built.command.param_id),
          featureKey: typeof params.feature_key === "string" ? params.feature_key : null,
          value: built.command.value as ConfigValue,
          pendingStatus: "pending" as const,
        }
      : type === "diagnostic" && built.command.type === "getparam"
        ? { paramId: Number(built.command.param_id), pendingStatus: "pending" as const }
        : undefined;

    const result = await dispatchDeviceCommand({
      imei,
      vehicleId: device.vehicle_id,
      commandType: type,
      payload: built.command,
      requestedBy: req.user!.id,
      reason,
      configState,
    });

    writeAudit({
      userId: req.user!.id,
      action: commandAuditAction(type, built.command),
      entity: "device_commands",
      entityId: result.id,
      newValue: { imei, vehicle_id: device.vehicle_id, command: result.serialized, type, params, reason },
    });

    if (forcedOverride) {
      writeAudit({
        userId: req.user!.id,
        action: "IGNITION_CUT_FORCED",
        entity: "device_commands",
        entityId: result.id,
        newValue: { imei, vehicle_id: device.vehicle_id, command: result.serialized, speed_kmh: cutSpeedKmh, reason, forced: true },
      });
    }

    const message = result.queued
      ? "Queued — device offline; will dispatch on next check-in"
      : "Queued / Pending Next Tracker Sync";
    res.status(201).json({ data: { ...result.row, status: normalizeCommandStatus(result.status) }, message });
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
    const rows = db.prepare(sql).all(...params) as any[];
    res.json({
      data: rows.map((row) => ({
        ...row,
        status: normalizeCommandStatus(row.status),
        raw_command: row.raw_command ?? (row.payload_json ? serializeCommand(JSON.parse(row.payload_json)) : null),
        response_payload: row.response_payload ?? row.response_text ?? null,
        created_by: row.created_by ?? row.requested_by ?? null,
      })),
    });
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

    const text = "Cancelled by user before dispatch";
    db.prepare("UPDATE device_commands SET status = 'failed', response_text = ?, response_payload = ?, updated_at = datetime('now') WHERE id = ?")
      .run(text, text, req.params.id);
    writeAudit({ userId: req.user!.id, action: "DEVICE_COMMAND_CANCELLED", entity: "device_commands", entityId: req.params.id, previousValue: row });
    res.json({
      data: { ...(db.prepare("SELECT * FROM device_commands WHERE id = ?").get(req.params.id) as any), status: "failed" },
      message: "Command cancelled",
    });
  } catch (e) {
    next(e);
  }
});

export default router;
