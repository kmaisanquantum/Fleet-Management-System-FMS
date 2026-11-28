import { createHash } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, verifyAccessToken } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { resolveClientScopes } from "../utils/scope";
import { writeAudit } from "../utils/audit";
import { isDeviceOnline } from "../utils/deviceStatus";
import {
  buildCommand,
  COMMAND_ROLES,
  commandAuditAction,
  dispatchDeviceCommand,
  fetchBridgeDevices,
  IGNITION_CUT_SPEED_LIMIT_KMH,
  latestSpeedKmh,
  normalizeCommandStatus,
  serializeCommand,
} from "../services/deviceCommands";
import {
  CONFIG_PRESETS,
  ConfigValue,
  ResolvedParameter,
  findPreset,
  getDeviceInfoSnapshot,
  lookupFeatureParam,
  resolvePreset,
  resolveRawParameter,
  resolveReadTarget,
} from "../services/deviceConfig";
import {
  TELTONIKA_FIELDS,
  TELTONIKA_LOAD_PARAM_IDS,
  teltonikaRegistryPayload,
} from "../services/teltonikaRegistry";

/**
 * Remote Teltonika FMB125 configuration.
 *
 * Configuration writes are queued in `device_commands`, forwarded to the
 * MeshSat Teltonika bridge (`MESHSAT_BRIDGE_URL` / `MESHSAT_BRIDGE_TOKEN`) and
 * applied by the tracker on its next TCP session. The bridge's tracker reply
 * comes back through `POST /api/telemetry/commands/ack`, which updates
 * `device_config_state` to `applied` or `failed`.
 */
const router = Router();

const configValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const parameterSchema = z
  .object({
    param_id: z.number().int().positive().optional(),
    feature_key: z.string().min(1).optional(),
    value: configValueSchema,
  })
  .refine((p) => p.param_id !== undefined || p.feature_key !== undefined, {
    message: "Each parameter needs a param_id or feature_key",
  });

const writeBodySchema = z.object({
  /** Raw parameter updates, e.g. `{ param_id: 1580, value: 80 }`. */
  parameters: z.array(parameterSchema).optional(),
  /** Named presets, e.g. `{ reporting_interval: 30 }` or a multi-key values object. */
  presets: z.record(z.union([configValueSchema, z.record(configValueSchema)])).optional(),
  /** Single preset with a scalar `value` or a `values` object. */
  preset: z.string().min(1).optional(),
  value: configValueSchema.optional(),
  values: z.record(configValueSchema).optional(),
  /** Operator-supplied justification, recorded in the audit log. */
  reason: z.string().optional(),
});

const configBodySchema = writeBodySchema
  .extend({
    /** Read-only parameter IDs or feature keys. */
    read: z.array(z.union([z.number().int().positive(), z.string().min(1)])).optional(),
    /** Convenience alias for numeric reads. */
    param_ids: z.array(z.number().int().positive()).optional(),
    /** Read-only diagnostic command. `getparam` requires `read`/`param_ids`. */
    diagnostic: z.enum(["getinfo", "getgps", "getver", "getstatus", "getio", "readio", "getparam"]).optional(),
  })
  .refine(
    (body) =>
      (body.parameters?.length ?? 0) > 0 ||
      (body.presets && Object.keys(body.presets).length > 0) ||
      !!body.preset ||
      (body.read?.length ?? 0) > 0 ||
      (body.param_ids?.length ?? 0) > 0 ||
      !!body.diagnostic,
    { message: "Supply parameters, a preset, read targets, or a diagnostic command" }
  );

const commandBodySchema = z
  .object({
    type: z
      .enum([
        "getinfo",
        "getver",
        "getstatus",
        "getgps",
        "getio",
        "readio",
        "getparam",
        "setparam",
        "setdigout",
        "camreq",
        "raw",
      ])
      .optional(),
    command: z.string().min(1).optional(),
    param_id: z.number().int().positive().optional(),
    feature_key: z.string().min(1).optional(),
    value: configValueSchema.optional(),
    dout: z.union([z.literal(0), z.literal(1), z.string(), z.number()]).optional(),
    state: z.union([z.literal(0), z.literal(1), z.string(), z.number()]).optional(),
    dout_index: z.number().int().positive().optional(),
    index: z.number().int().positive().optional(),
    timeout: z.number().int().nonnegative().optional(),
    channel: z.number().int().positive().optional(),
    reason: z.string().optional(),
    force: z.boolean().optional(),
    /** Explicit safety confirmation for setdigout. */
    confirm: z.boolean().optional(),
  })
  .refine((body) => body.type !== undefined || body.command !== undefined, {
    message: "Supply a command type or a raw command",
  });

const bulkBodySchema = writeBodySchema
  .extend({
    imeis: z.array(z.string().min(1)).min(1).max(100),
  })
  .refine(
    (body) =>
      (body.parameters?.length ?? 0) > 0 ||
      (body.presets && Object.keys(body.presets).length > 0) ||
      !!body.preset,
    { message: "Supply parameters, presets, or a preset" }
  );

interface DeviceRow {
  id: string;
  vehicle_id: string | null;
  client_id: string | null;
  device_model: string | null;
  last_seen_at: string | null;
}

function loadDevice(imei: string): DeviceRow | undefined {
  return db
    .prepare("SELECT id, vehicle_id, client_id, device_model, last_seen_at FROM gps_devices WHERE device_identifier = ?")
    .get(imei) as DeviceRow | undefined;
}

function assertDeviceAccess(device: DeviceRow | undefined, req: any): { status: number; error: string } | null {
  if (!device) return { status: 404, error: "Unknown device" };
  if (!device.vehicle_id) return { status: 400, error: "Device not bound to a vehicle" };
  const scope = resolveClientScopes(req.user);
  if (scope && (!device.client_id || !scope.includes(device.client_id))) {
    return { status: 403, error: "Forbidden: device is outside your client scope" };
  }
  return null;
}

function configPresetsForResponse() {
  return CONFIG_PRESETS.map((preset) => ({
    ...preset,
    parameters: preset.parameters.map((p) => {
      const mapped = lookupFeatureParam(p.feature_key);
      return {
        ...p,
        param_id: mapped?.param_id ?? null,
        description: mapped?.description ?? null,
        unit: mapped?.unit ?? null,
      };
    }),
  }));
}

function normalizeCommandRow(row: any) {
  let rawCommand = row.raw_command;
  if (!rawCommand && row.payload_json) {
    try {
      rawCommand = serializeCommand(JSON.parse(row.payload_json));
    } catch {
      rawCommand = null;
    }
  }
  return {
    ...row,
    status: normalizeCommandStatus(row.status),
    raw_command: rawCommand,
    response_payload: row.response_payload ?? row.response_text ?? null,
    created_by: row.created_by ?? row.requested_by ?? null,
  };
}

function resolveWrites(body: z.infer<typeof writeBodySchema>): {
  writes: ResolvedParameter[];
  errors: string[];
} {
  const writes: ResolvedParameter[] = [];
  const errors: string[] = [];

  for (const p of body.parameters ?? []) {
    const resolved = resolveRawParameter(p);
    if (resolved.error) errors.push(resolved.error);
    else if (resolved.parameter) writes.push(resolved.parameter);
  }

  for (const [key, value] of Object.entries(body.presets ?? {})) {
    const preset = findPreset(key);
    if (!preset) {
      errors.push(`Unknown preset '${key}'`);
      continue;
    }
    const resolved = resolvePreset(preset, value);
    if (resolved.error) errors.push(resolved.error);
    else writes.push(...resolved.parameters);
  }

  if (body.preset) {
    const preset = findPreset(body.preset);
    if (!preset) errors.push(`Unknown preset '${body.preset}'`);
    else {
      const resolved = resolvePreset(preset, body.values ?? body.value);
      if (resolved.error) errors.push(resolved.error);
      else writes.push(...resolved.parameters);
    }
  }

  // Last write for a parameter wins if the caller supplies duplicates.
  const byParam = new Map<number, ResolvedParameter>();
  for (const write of writes) byParam.set(write.param_id, write);
  return { writes: [...byParam.values()], errors };
}

async function queueWrites(
  imei: string,
  device: DeviceRow,
  writes: ResolvedParameter[],
  userId: string,
  reason: string | null
) {
  const results: any[] = [];
  for (const parameter of writes) {
    const payload = {
      type: "setparam",
      param_id: parameter.param_id,
      feature_key: parameter.feature_key,
      value: parameter.value,
    };
    const result = await dispatchDeviceCommand({
      imei,
      vehicleId: device.vehicle_id!,
      commandType: "setparam",
      payload,
      requestedBy: userId,
      reason,
      configState: {
        paramId: parameter.param_id,
        featureKey: parameter.feature_key,
        value: parameter.value,
        pendingStatus: "pending",
        presetKey: parameter.preset_key ?? null,
        presetMetadata: parameter.preset_metadata ?? null,
      },
    });
    writeAudit({
      userId,
      action: "DEVICE_CONFIG_QUEUED",
      entity: "device_commands",
      entityId: result.id,
      newValue: {
        imei,
        vehicle_id: device.vehicle_id,
        command_type: "setparam",
        payload,
        reason,
        preset_key: parameter.preset_key ?? null,
      },
    });
    results.push({
      id: result.id,
      command_type: "setparam",
      command: result.serialized,
      status: normalizeCommandStatus(result.status),
      config_status: result.configStatus,
      response_text: result.responseText,
      queued: result.queued,
    });
  }
  return results;
}

/** Stable short hash of the last applied parameter values. */
function configVersionFor(imei: string): string | null {
  const rows = db
    .prepare("SELECT param_id, applied_value FROM device_config_state WHERE imei = ? AND status = 'applied' ORDER BY param_id")
    .all(imei) as { param_id: number; applied_value: string | null }[];
  if (rows.length === 0) return null;
  const hash = createHash("sha1")
    .update(rows.map((row) => `${row.param_id}=${row.applied_value ?? ""}`).join("|"))
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `CFG-${hash}`;
}

function loadParameterStates(imei: string) {
  return db
    .prepare(`
      SELECT param_id, feature_key, value, desired_value, applied_value,
             status, command_id, requested_at, applied_at, response_text,
             preset_key, preset_metadata, updated_at
      FROM device_config_state
      WHERE imei = ?
      ORDER BY param_id ASC
    `)
    .all(imei);
}

async function dispatchAndAudit(input: {
  imei: string;
  vehicleId: string;
  userId: string;
  commandType: "diagnostic" | "raw";
  payload: Record<string, unknown>;
  reason: string | null;
  action?: string;
}) {
  const result = await dispatchDeviceCommand({
    imei: input.imei,
    vehicleId: input.vehicleId,
    commandType: input.commandType,
    payload: input.payload,
    requestedBy: input.userId,
    reason: input.reason,
  });
  writeAudit({
    userId: input.userId,
    action: input.action ?? "DEVICE_COMMAND_QUEUED",
    entity: "device_commands",
    entityId: result.id,
    newValue: {
      imei: input.imei,
      vehicle_id: input.vehicleId,
      command_type: input.commandType,
      payload: input.payload,
      reason: input.reason,
    },
  });
  return result;
}

/**
 * GET /api/devices — local device inventory for the IMEI selector. MeshSat's
 * authoritative online state is available separately through `GET /bridge`.
 */
router.get("/", requireAuth, (req, res, next) => {
  try {
    const scope = resolveClientScopes(req.user);
    let sql = `
      SELECT d.device_identifier AS imei, d.device_model, d.vehicle_id, d.client_id,
             d.last_seen_at, d.firmware_version,
             v.vehicle_number, v.registration_number
      FROM gps_devices d
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
    `;
    const params: string[] = [];
    if (scope) {
      sql += ` WHERE d.client_id IN (${scope.map(() => "?").join(", ")})`;
      params.push(...scope);
    }
    sql += " ORDER BY v.vehicle_number ASC, d.device_identifier ASC";
    const rows = db.prepare(sql).all(...params) as any[];
    res.json({
      data: rows.map((row) => ({
        ...row,
        online: isDeviceOnline(row.last_seen_at),
      })),
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/devices/registry — central Teltonika parameter dictionary. */
router.get("/registry", requireAuth, (_req, res) => {
  res.json({ data: teltonikaRegistryPayload() });
});

/** GET /api/devices/bridge — proxy MeshSat's GET /api/devices inventory. */
router.get("/bridge", requireAuth, requireRole(...COMMAND_ROLES), async (_req, res, next) => {
  try {
    const result = await fetchBridgeDevices();
    if (!result.configured) {
      return res.status(503).json({ error: result.text, configured: false });
    }
    if (!result.ok) {
      return res.status(result.status || 502).json({
        error: "MeshSat bridge device inventory unavailable",
        detail: result.text,
        configured: true,
      });
    }
    res.json({ data: result.data });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/devices/:imei/load
 *
 * Dispatches `getinfo`, `getver`, `getstatus`, `getio`, and `getparam` for the
 * active registry parameters. Tracker replies arrive asynchronously through
 * the bridge ack callback and populate `device_config_state`.
 */
const loadBodySchema = z.object({
  param_ids: z.array(z.number().int().positive()).max(200).optional(),
  reason: z.string().optional(),
});

router.post("/:imei/load", requireAuth, requireRole(...COMMAND_ROLES), async (req, res, next) => {
  try {
    const parsed = loadBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid load payload", details: parsed.error.flatten() });
    }
    const imei = req.params.imei;
    const device = loadDevice(imei);
    const denied = assertDeviceAccess(device, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const reason = (parsed.data.reason ?? "Load configuration from device").trim();
    const paramIds = [...new Set(parsed.data.param_ids ?? TELTONIKA_LOAD_PARAM_IDS)].slice(0, 150);
    const results: any[] = [];

    for (const command of ["getinfo", "getver", "getstatus", "getio", "getgps"]) {
      const result = await dispatchAndAudit({
        imei,
        vehicleId: device!.vehicle_id!,
        userId: req.user!.id,
        commandType: "diagnostic",
        payload: { type: "diagnostic", command },
        reason,
      });
      results.push({
        id: result.id,
        command: result.serialized,
        status: normalizeCommandStatus(result.status),
        queued: result.queued,
      });
    }

    for (let offset = 0; offset < paramIds.length; offset += 8) {
      const chunk = paramIds.slice(offset, offset + 8);
      const chunkResults = await Promise.all(
        chunk.map((paramId) =>
          dispatchAndAudit({
            imei,
            vehicleId: device!.vehicle_id!,
            userId: req.user!.id,
            commandType: "diagnostic",
            payload: { type: "getparam", param_id: paramId },
            reason,
          })
        )
      );
      for (const result of chunkResults) {
        results.push({
          id: result.id,
          command: result.serialized,
          status: normalizeCommandStatus(result.status),
          queued: result.queued,
        });
      }
    }

    res.status(201).json({
      data: { commands: results, param_ids: paramIds },
      message: `Load requested: 5 identity commands and ${paramIds.length} parameter reads queued. Values update as the tracker replies.`,
    });
  } catch (e) {
    next(e);
  }
});

/** POST /api/devices/:imei/read-records — flush/read the latest AVL state. */
const readRecordsBodySchema = z.object({ reason: z.string().optional() });

router.post("/:imei/read-records", requireAuth, requireRole(...COMMAND_ROLES), async (req, res, next) => {
  try {
    const parsed = readRecordsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid read-records payload", details: parsed.error.flatten() });
    }
    const imei = req.params.imei;
    const device = loadDevice(imei);
    const denied = assertDeviceAccess(device, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const reason = (parsed.data.reason ?? "Read latest records").trim();
    const commands: any[] = [];
    for (const command of ["getgps", "getstatus", "getio"]) {
      const result = await dispatchAndAudit({
        imei,
        vehicleId: device!.vehicle_id!,
        userId: req.user!.id,
        commandType: "diagnostic",
        payload: { type: "diagnostic", command },
        reason,
      });
      commands.push({ id: result.id, command: result.serialized, status: normalizeCommandStatus(result.status) });
    }

    const latest = db
      .prepare("SELECT * FROM telemetry_records WHERE imei = ? ORDER BY recorded_at DESC LIMIT 1")
      .get(imei) as Record<string, unknown> | undefined;

    res.status(201).json({
      data: { commands, latest_record: latest ?? null },
      message: "Record flush requested. The latest AVL state is returned now; fresh records appear after the tracker's next sync.",
    });
  } catch (e) {
    next(e);
  }
});

/** POST /api/devices/:imei/reboot — guarded `cpureset`. */
const rebootBodySchema = z.object({
  confirm: z.literal(true),
  reason: z.string().optional(),
});

router.post("/:imei/reboot", requireAuth, requireRole(...COMMAND_ROLES), async (req, res, next) => {
  try {
    const parsed = rebootBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Explicit confirmation is required to reboot the device" });
    }
    const imei = req.params.imei;
    const device = loadDevice(imei);
    const denied = assertDeviceAccess(device, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const reason = (parsed.data.reason ?? "Device reboot confirmed by operator").trim();
    const result = await dispatchAndAudit({
      imei,
      vehicleId: device!.vehicle_id!,
      userId: req.user!.id,
      commandType: "raw",
      payload: { type: "raw", command: "cpureset" },
      reason,
      action: "DEVICE_REBOOT_QUEUED",
    });

    res.status(201).json({
      data: { id: result.id, command: result.serialized, status: normalizeCommandStatus(result.status), queued: result.queued },
      message: "Reboot command queued. The tracker restarts on its next MeshSat sync.",
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/devices/:imei/events — Server-Sent Events snapshot stream.
 * The client reads this with `fetch` so the bearer token stays in the
 * Authorization header and never appears in a URL or proxy access log.
 */
router.get("/:imei/events", (req, res, next) => {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token) return res.status(401).json({ error: "Missing bearer token" });
    try {
      req.user = verifyAccessToken(token);
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const imei = req.params.imei;
    const device = loadDevice(imei);
    const denied = assertDeviceAccess(device, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    let previous = "";
    const send = () => {
      const latest = db
        .prepare("SELECT MAX(updated_at) AS updated_at FROM device_config_state WHERE imei = ?")
        .get(imei) as { updated_at: string | null } | undefined;
      const lastCommand = db
        .prepare("SELECT MAX(updated_at) AS updated_at FROM device_commands WHERE imei = ?")
        .get(imei) as { updated_at: string | null } | undefined;
      const queued = db
        .prepare("SELECT COUNT(*) AS count FROM device_commands WHERE imei = ? AND status = 'queued'")
        .get(imei) as { count: number };
      const snapshot = {
        imei,
        online: isDeviceOnline(device!.last_seen_at),
        last_seen_at: device!.last_seen_at,
        queued_count: queued.count,
        config_updated_at: latest?.updated_at ?? null,
        command_updated_at: lastCommand?.updated_at ?? null,
        config_version: configVersionFor(imei),
      };
      const serialized = JSON.stringify(snapshot);
      if (serialized !== previous) {
        previous = serialized;
        res.write(`event: snapshot\ndata: ${serialized}\n\n`);
      } else {
        res.write(": keep-alive\n\n");
      }
    };

    send();
    const interval = setInterval(send, 3000);
    req.on("close", () => clearInterval(interval));
  } catch (e) {
    next(e);
  }
});

/** GET /api/devices/:imei/config — current state, mapped presets, recent commands. */
router.get("/:imei/config", requireAuth, (req, res, next) => {
  try {
    const imei = req.params.imei;
    const device = loadDevice(imei);
    const denied = assertDeviceAccess(device, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const vehicle = db
      .prepare("SELECT vehicle_number, registration_number, last_seen_at FROM vehicles WHERE id = ?")
      .get(device!.vehicle_id) as
      | { vehicle_number: string; registration_number: string; last_seen_at: string | null }
      | undefined;
    const deviceInfo = getDeviceInfoSnapshot(imei);
    const parameterStates = loadParameterStates(imei);

    const parameters = db
      .prepare(`
        SELECT pm.param_id, pm.feature_key, pm.description, pm.unit,
               cs.value, cs.desired_value, cs.applied_value,
               COALESCE(cs.status, 'unknown') AS status,
               cs.command_id, cs.requested_at, cs.applied_at, cs.response_text,
               cs.preset_key, cs.preset_metadata
        FROM param_map pm
        LEFT JOIN device_config_state cs
          ON cs.imei = ? AND cs.param_id = pm.param_id
        ORDER BY pm.feature_key ASC, pm.param_id ASC
      `)
      .all(imei);

    const commandRows = db
      .prepare("SELECT * FROM device_commands WHERE imei = ? ORDER BY created_at DESC LIMIT 50")
      .all(imei) as any[];
    const commands = commandRows.map(normalizeCommandRow);

    const lastApplied = db
      .prepare("SELECT MAX(applied_at) AS applied_at FROM device_config_state WHERE imei = ? AND status = 'applied'")
      .get(imei) as { applied_at: string | null } | undefined;

    const lastInfo = commands.find((row) => {
      if (row.command_type !== "diagnostic" || !row.payload_json) return false;
      try {
        const payload = JSON.parse(row.payload_json);
        return payload.command === "getinfo" || payload.command === "getver";
      } catch {
        return false;
      }
    });

    const queuedCount =
      (db.prepare("SELECT COUNT(*) AS count FROM device_commands WHERE imei = ? AND status = 'queued'").get(imei) as { count: number })
        .count ?? 0;

    res.json({
      data: {
        imei,
        vehicle_id: device!.vehicle_id,
        client_id: device!.client_id,
        device_model: device!.device_model,
        vehicle_number: vehicle?.vehicle_number ?? null,
        registration_number: vehicle?.registration_number ?? null,
        last_seen_at: vehicle?.last_seen_at ?? null,
        device_last_seen_at: device!.last_seen_at ?? null,
        online: isDeviceOnline(device!.last_seen_at),
        firmware_version: deviceInfo.firmware_version,
        config_version: configVersionFor(imei),
        device_info: deviceInfo.info,
        device_info_updated_at: deviceInfo.updated_at,
        last_applied_at: lastApplied?.applied_at ?? null,
        last_sync_info: lastInfo?.response_text ?? null,
        last_sync_at: lastInfo?.acked_at ?? lastInfo?.created_at ?? null,
        queued_count: queuedCount,
        parameters,
        parameter_states: parameterStates,
        registry_param_count: TELTONIKA_FIELDS.length,
        presets: configPresetsForResponse(),
        commands,
        command_history: commands,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/devices/:imei/config
 *
 * Body forms:
 *  - `{ parameters: [{ param_id, value }] }` — raw writes
 *  - `{ presets: { reporting_interval: 30 } }` — named preset writes
 *  - `{ preset: "data_acquisition", values: { ignition_on: 10, ignition_off: 60 } }`
 *  - `{ read: [100, 102] }` or `{ diagnostic: "getparam", param_ids: [100] }`
 *  - `{ diagnostic: "getinfo" }`
 */
router.post("/:imei/config", requireAuth, requireRole(...COMMAND_ROLES), async (req, res, next) => {
  try {
    const imei = req.params.imei;
    const parsed = configBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid configuration payload", details: parsed.error.flatten() });
    }

    const device = loadDevice(imei);
    const denied = assertDeviceAccess(device, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const body = parsed.data;
    const reason = (body.reason ?? "").trim() || null;
    const { writes, errors } = resolveWrites(body);

    const readParamIds = new Set<number>();
    for (const target of body.read ?? []) {
      const resolved = resolveReadTarget(target);
      if (resolved.error) errors.push(resolved.error);
      else if (resolved.param_id !== undefined) readParamIds.add(resolved.param_id);
    }
    for (const id of body.param_ids ?? []) readParamIds.add(id);

    if (body.diagnostic === "getparam" && readParamIds.size === 0) {
      errors.push("getparam requires at least one read target (read or param_ids)");
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: "Invalid configuration payload", details: errors });
    }

    if (writes.length === 0 && readParamIds.size === 0 && !body.diagnostic) {
      return res.status(400).json({ error: "No configuration action supplied" });
    }

    const results = await queueWrites(imei, device!, writes, req.user!.id, reason);

    for (const paramId of readParamIds) {
      const payload = { type: "getparam", param_id: paramId };
      const result = await dispatchDeviceCommand({
        imei,
        vehicleId: device!.vehicle_id!,
        commandType: "diagnostic",
        payload,
        requestedBy: req.user!.id,
        reason,
        configState: { paramId, pendingStatus: "pending" },
      });
      writeAudit({
        userId: req.user!.id,
        action: "DEVICE_CONFIG_QUEUED",
        entity: "device_commands",
        entityId: result.id,
        newValue: { imei, vehicle_id: device!.vehicle_id, command_type: "diagnostic", payload, reason },
      });
      results.push({
        id: result.id,
        command_type: "diagnostic",
        command: result.serialized,
        status: normalizeCommandStatus(result.status),
        config_status: result.configStatus,
        response_text: result.responseText,
        queued: result.queued,
      });
    }

    if (body.diagnostic && body.diagnostic !== "getparam") {
      const payload = { type: "diagnostic", command: body.diagnostic };
      const result = await dispatchDeviceCommand({
        imei,
        vehicleId: device!.vehicle_id!,
        commandType: "diagnostic",
        payload,
        requestedBy: req.user!.id,
        reason,
      });
      writeAudit({
        userId: req.user!.id,
        action: "DEVICE_COMMAND_QUEUED",
        entity: "device_commands",
        entityId: result.id,
        newValue: { imei, vehicle_id: device!.vehicle_id, command_type: "diagnostic", payload, reason },
      });
      results.push({
        id: result.id,
        command_type: "diagnostic",
        command: result.serialized,
        status: normalizeCommandStatus(result.status),
        config_status: result.configStatus,
        response_text: result.responseText,
        queued: result.queued,
      });
    }

    const failed = results.filter((r) => r.status === "failed").length;
    const queued = results.filter((r) => r.queued).length;
    const message = failed
      ? `${results.length} configuration command(s) queued; ${failed} could not be delivered to MeshSat.`
      : queued
        ? `${results.length} configuration command(s) queued; ${queued} waiting for the device's next check-in.`
        : `${results.length} configuration command(s) queued. The tracker applies them on its next MeshSat sync.`;

    res.status(201).json({
      data: {
        commands: results.map((r) => normalizeCommandRow(db.prepare("SELECT * FROM device_commands WHERE id = ?").get(r.id))),
        results,
      },
      message,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/devices/:imei/command
 * Immediate diagnostic/control actions: getinfo, getver, getstatus,
 * getparam <id>, and setdigout <state> (confirmation required).
 */
router.post("/:imei/command", requireAuth, requireRole(...COMMAND_ROLES), async (req, res, next) => {
  try {
    const imei = req.params.imei;
    const parsed = commandBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid command payload", details: parsed.error.flatten() });
    }
    const device = loadDevice(imei);
    const denied = assertDeviceAccess(device, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const body = parsed.data;
    const reason = (body.reason ?? "").trim() || null;
    const action = body.type ?? body.command ?? "";
    const diagnostic = new Set(["getinfo", "getver", "getstatus", "getgps", "getio", "readio", "getparam"]);

    let built: ReturnType<typeof buildCommand>;
    let commandType: string;
    if (diagnostic.has(action)) {
      built = buildCommand("diagnostic", {
        command: action,
        ...(body.param_id !== undefined ? { param_id: body.param_id } : {}),
      });
      commandType = "diagnostic";
    } else if (action === "setparam") {
      built = buildCommand("setparam", {
        ...(body.param_id !== undefined ? { param_id: body.param_id } : {}),
        ...(body.feature_key !== undefined ? { feature_key: body.feature_key } : {}),
        ...(body.value !== undefined ? { value: body.value } : {}),
      });
      commandType = "setparam";
    } else if (action === "setdigout") {
      if (body.confirm !== true) {
        return res.status(400).json({ error: "Explicit confirmation is required for a digital-output change" });
      }
      built = buildCommand("setdigout", {
        dout: (body.dout ?? body.state ?? "") as string | number,
        ...(body.dout_index !== undefined ? { dout_index: body.dout_index } : {}),
        ...(body.index !== undefined ? { index: body.index } : {}),
        ...(body.timeout !== undefined ? { timeout: body.timeout } : {}),
      });
      commandType = "setdigout";
    } else if (action === "camreq") {
      built = buildCommand("camreq", body.channel !== undefined ? { channel: body.channel } : {});
      commandType = "camreq";
    } else if (action === "raw" || body.command) {
      built = buildCommand("raw", { command: body.command ?? "" });
      commandType = "raw";
    } else {
      return res.status(400).json({ error: "Unsupported command action", details: action });
    }

    if (!built.command) return res.status(400).json({ error: "Invalid command parameters", details: built.error });

    const isIgnitionCut = commandType === "setdigout" && built.command.dout === 1;
    let forcedOverride = false;
    let cutSpeedKmh: number | null = null;
    if (isIgnitionCut) {
      if (!reason) {
        return res.status(400).json({ error: "A reason is required for an ignition cut", details: "Supply a non-empty 'reason'" });
      }
      cutSpeedKmh = latestSpeedKmh(device!.vehicle_id!);
      if (cutSpeedKmh !== null && cutSpeedKmh > IGNITION_CUT_SPEED_LIMIT_KMH) {
        const canForce = req.user!.roleName === "admin" && body.force === true;
        if (!canForce) return res.status(409).json({ error: "Vehicle moving — ignition cut blocked", speed_kmh: cutSpeedKmh });
        forcedOverride = true;
      }
    }

    const configState = commandType === "setparam"
      ? {
          paramId: Number(built.command.param_id),
          featureKey: body.feature_key ?? null,
          value: built.command.value as ConfigValue,
          pendingStatus: "pending" as const,
        }
      : commandType === "diagnostic" && built.command.type === "getparam"
        ? { paramId: Number(built.command.param_id), pendingStatus: "pending" as const }
        : undefined;

    const result = await dispatchDeviceCommand({
      imei,
      vehicleId: device!.vehicle_id!,
      commandType,
      payload: built.command,
      requestedBy: req.user!.id,
      reason,
      configState,
    });

    writeAudit({
      userId: req.user!.id,
      action: commandAuditAction(commandType, built.command),
      entity: "device_commands",
      entityId: result.id,
      newValue: { imei, vehicle_id: device!.vehicle_id, command: result.serialized, command_type: commandType, reason },
    });
    if (forcedOverride) {
      writeAudit({
        userId: req.user!.id,
        action: "IGNITION_CUT_FORCED",
        entity: "device_commands",
        entityId: result.id,
        newValue: { imei, vehicle_id: device!.vehicle_id, command: result.serialized, speed_kmh: cutSpeedKmh, reason, forced: true },
      });
    }

    res.status(201).json({
      data: normalizeCommandRow(result.row),
      message: result.queued
        ? "Queued — device offline; will dispatch on next check-in"
        : "Command queued for the tracker's next MeshSat sync.",
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/devices/bulk-config
 * Applies a preset or parameter set across multiple IMEIs sequentially, with
 * per-device status tracking.
 */
router.post("/bulk-config", requireAuth, requireRole(...COMMAND_ROLES), async (req, res, next) => {
  try {
    const parsed = bulkBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid bulk configuration payload", details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const reason = (body.reason ?? "").trim() || null;
    const { writes, errors } = resolveWrites(body);
    if (errors.length > 0) {
      return res.status(400).json({ error: "Invalid bulk configuration payload", details: errors });
    }
    if (writes.length === 0) {
      return res.status(400).json({ error: "No configuration action supplied" });
    }

    const results: any[] = [];
    for (const imei of [...new Set(body.imeis)]) {
      const device = loadDevice(imei);
      const denied = assertDeviceAccess(device, req);
      if (denied) {
        results.push({ imei, ok: false, status: "failed", error: denied.error });
        continue;
      }
      const commandResults = await queueWrites(imei, device!, writes, req.user!.id, reason);
      const failed = commandResults.filter((r) => r.status === "failed").length;
      results.push({
        imei,
        ok: failed === 0,
        status: failed === 0 ? (commandResults.every((r) => r.queued) ? "queued" : "sent") : "failed",
        command_ids: commandResults.map((r) => r.id),
        results: commandResults,
      });
    }

    const appliedCount = results.filter((r) => r.ok).length;
    res.status(200).json({
      data: { results },
      message: `Configuration queued for ${appliedCount}/${results.length} device(s).`,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
