import { v4 as uuid } from "uuid";
import { db } from "../db";
import { isDeviceOnline, nowSql } from "../utils/deviceStatus";
import { applyConfigAck, ConfigStatus, ConfigValue, parseTrackerReply, upsertConfigState } from "./deviceConfig";

/** Roles permitted to dispatch device commands (client-role users are excluded). */
export const COMMAND_ROLES = ["admin", "fleet_manager"];

/**
 * Read-only status commands the FMB125 accepts. Only these exact strings may be
 * issued through the `diagnostic` type; arbitrary strings must go through `raw`.
 */
export const DIAGNOSTIC_COMMANDS = new Set([
  "getinfo",
  "getgps",
  "getver",
  "getstatus",
  "getio",
  "readio",
  "getparam",
]);

/**
 * Speed above which an ignition cut (setdigout 1) is refused: immobilising a
 * moving vehicle is unsafe. Overridable only by an `admin` that explicitly
 * passes `force: true` (which is audited as IGNITION_CUT_FORCED).
 */
export const IGNITION_CUT_SPEED_LIMIT_KMH = 10;

export type CommandType = "setparam" | "setdigout" | "diagnostic" | "raw" | "camreq";

export interface BuiltCommand {
  command?: Record<string, unknown>;
  error?: string;
}

/**
 * Builds the concrete Codec-12 command from a validated request. `setparam`
 * requires a parameter resolvable through `param_map` (by `param_id` or
 * `feature_key`); `setdigout` requires a 0/1 DOUT state (with an optional
 * `dout_index`, defaulting to DOUT 1, and an optional non-negative `timeout`);
 * `diagnostic` requires a whitelisted status command; `camreq` requests a
 * camera snapshot (optional positive `channel`).
 */
export function buildCommand(
  type: CommandType,
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
    const rawIndex = params.dout_index ?? params.index;
    if (rawIndex !== undefined && rawIndex !== null && rawIndex !== "") {
      const doutIndex = Number(rawIndex);
      if (!Number.isInteger(doutIndex) || doutIndex < 1) return { error: "setdigout 'dout_index' must be a positive integer" };
      command.dout_index = doutIndex;
    }
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
    if (cmd === "getparam") {
      const paramId = Number(params.param_id);
      if (!Number.isInteger(paramId) || paramId <= 0) {
        return { error: "getparam requires a positive integer 'param_id'" };
      }
      return { command: { type: "getparam", param_id: paramId } };
    }
    return { command: { type: "diagnostic", command: cmd } };
  }

  if (type === "camreq") {
    const command: Record<string, unknown> = { type: "camreq" };
    const rawChannel = params.channel ?? params.camera_channel;
    if (rawChannel !== undefined && rawChannel !== null && rawChannel !== "") {
      const channel = Number(rawChannel);
      if (!Number.isInteger(channel) || channel < 1) return { error: "camreq 'channel' must be a positive integer" };
      command.channel = channel;
    }
    return { command };
  }

  if (typeof params.command !== "string" || !params.command) return { error: "raw requires a 'command' string" };
  return { command: { type: "raw", command: params.command } };
}

/**
 * Serializes a built command into the Teltonika command string the bridge
 * forwards over Codec 12 (e.g. `setparam 1580:80`, `setdigout 1 1`,
 * `setdigout 1 1 30000`, `getgps`, `getparam 100`, `camreq 1`).
 */
export function serializeCommand(command: Record<string, unknown>): string {
  switch (command.type) {
    case "setparam":
      return `setparam ${command.param_id}:${command.value}`;
    case "setdigout": {
      const index = command.dout_index ?? 1;
      const parts = ["setdigout", String(command.dout), String(index)];
      if (command.timeout !== undefined && command.timeout !== null) parts.push(String(command.timeout));
      return parts.join(" ");
    }
    case "getparam":
      return `getparam ${command.param_id}`;
    case "camreq":
      return command.channel !== undefined && command.channel !== null ? `camreq ${command.channel}` : "camreq";
    case "diagnostic":
    case "raw":
      return String(command.command);
    default:
      return JSON.stringify(command);
  }
}

/** Most recent reported speed (km/h) for a vehicle, or null when unknown. */
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

/** Maps legacy ack statuses onto the operator-facing `applied` status. */
export function normalizeCommandStatus(status: string | null | undefined): string {
  if (status === "acknowledged" || status === "acked") return "applied";
  return status || "queued";
}

/** Audit action for a dispatched command (immobilizer actions are distinct). */
export function commandAuditAction(commandType: string, payload: Record<string, unknown>): string {
  if (commandType === "setdigout") {
    return payload.dout === 1 ? "IGNITION_CUT_QUEUED" : "IGNITION_RESTORE_QUEUED";
  }
  return "DEVICE_COMMAND_QUEUED";
}

interface ForwardResult {
  ok: boolean;
  status: number;
  text: string;
  transportError?: boolean;
}

/**
 * Hands a command to the MeshSat Teltonika bridge.
 *
 * Preferred contract:
 *   POST ${MESHSAT_BRIDGE_URL}/api/devices/:imei/command
 *   Authorization: Bearer ${MESHSAT_BRIDGE_TOKEN}
 *   { imei, command, command_type, command_id }
 *
 * `MESHSAT_API_URL` / `MESHSAT_API_KEY` and `MESHSAT_CMD_URL` /
 * `MESHSAT_CMD_TOKEN` remain supported as fallbacks for existing deployments.
 */
export async function forwardCommand(
  imei: string,
  command: string,
  meta?: { commandType?: string; commandId?: string }
): Promise<ForwardResult> {
  const timeoutMs = Number(process.env.MESHSAT_TIMEOUT_MS) || 5000;
  const signal = AbortSignal.timeout(timeoutMs);
  const bridgeBase = process.env.MESHSAT_BRIDGE_URL?.trim();
  if (bridgeBase) {
    const base = bridgeBase.replace(/\/+$/, "");
    const endpoint = base.endsWith("/command")
      ? base
      : base.endsWith("/api/devices")
        ? `${base}/${encodeURIComponent(imei)}/command`
        : `${base}/api/devices/${encodeURIComponent(imei)}/command`;
    const token = process.env.MESHSAT_BRIDGE_TOKEN || process.env.MESHSAT_API_KEY || process.env.MESHSAT_CMD_TOKEN || "";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          imei,
          command,
          command_type: meta?.commandType,
          command_id: meta?.commandId,
        }),
        signal,
      });
      const text = await res.text().catch(() => "");
      return { ok: res.ok, status: res.status, text };
    } catch (err: any) {
      return { ok: false, status: 0, text: `Bridge unreachable: ${err?.message ?? String(err)}`, transportError: true };
    }
  }

  const configuredBase = process.env.MESHSAT_API_URL || process.env.MESHSAT_CMD_URL || "https://meshsat.dspng.space";
  const baseUrl = configuredBase.replace(/\/+$/, "");
  const endpoint = baseUrl.endsWith("/api/cmd") ? baseUrl : `${baseUrl}/api/cmd`;
  const token = process.env.MESHSAT_API_KEY || process.env.MESHSAT_CMD_TOKEN || "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ imei, command }),
      signal,
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  } catch (err: any) {
    return { ok: false, status: 0, text: `Command endpoint unreachable: ${err?.message ?? String(err)}`, transportError: true };
  }
}

export interface BridgeDevicesResult {
  ok: boolean;
  status: number;
  data: unknown;
  text: string;
  configured: boolean;
}

/**
 * Reads the bridge's device inventory (`GET /api/devices`). Used by the
 * configurator's IMEI selector so operators see MeshSat's online state, not
 * only the FMS ingest cache.
 */
export async function fetchBridgeDevices(): Promise<BridgeDevicesResult> {
  const bridgeBase = process.env.MESHSAT_BRIDGE_URL?.trim();
  if (!bridgeBase) {
    return { ok: false, status: 0, data: null, text: "MESHSAT_BRIDGE_URL is not configured", configured: false };
  }
  const base = bridgeBase.replace(/\/+$/, "");
  const endpoint = base.endsWith("/api/devices") ? base : `${base}/api/devices`;
  const token = process.env.MESHSAT_BRIDGE_TOKEN || process.env.MESHSAT_API_KEY || process.env.MESHSAT_CMD_TOKEN || "";
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Number(process.env.MESHSAT_TIMEOUT_MS) || 5000),
    });
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data, text, configured: true };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      data: null,
      text: `Bridge unreachable: ${err?.message ?? String(err)}`,
      configured: true,
    };
  }
}

interface DeviceRow {
  id: string;
  vehicle_id: string | null;
  client_id: string | null;
  last_seen_at: string | null;
}

function loadDevice(imei: string): DeviceRow | undefined {
  return db
    .prepare("SELECT id, vehicle_id, client_id, last_seen_at FROM gps_devices WHERE device_identifier = ?")
    .get(imei) as DeviceRow | undefined;
}

export interface CommandConfigState {
  paramId: number;
  featureKey?: string | null;
  value?: ConfigValue | null;
  /** Config state shown before the tracker replies. */
  pendingStatus?: ConfigStatus;
  presetKey?: string | null;
  presetMetadata?: string | null;
}

export interface DispatchInput {
  imei: string;
  vehicleId: string;
  commandType: string;
  payload: Record<string, unknown>;
  requestedBy?: string | null;
  reason?: string | null;
  configState?: CommandConfigState;
}

export interface DispatchResult {
  id: string;
  row: any;
  serialized: string;
  status: string;
  configStatus: ConfigStatus | "unknown";
  responseText: string | null;
  queued: boolean;
  sentAt: string | null;
  ackedAt: string | null;
}

function insertCommand(input: DispatchInput, serialized: string): string {
  const id = uuid();
  const timestamp = nowSql();
  db.prepare(`
    INSERT INTO device_commands (
      id, imei, vehicle_id, command_type, payload_json, raw_command, status,
      requested_by, created_by, reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
  `).run(
    id,
    input.imei,
    input.vehicleId,
    input.commandType,
    JSON.stringify(input.payload),
    serialized,
    input.requestedBy ?? null,
    input.requestedBy ?? null,
    input.reason ?? null,
    timestamp,
    timestamp
  );
  return id;
}

function updateCommand(
  id: string,
  status: string,
  sentAt: string | null,
  responseText: string | null,
  ackedAt: string | null
): void {
  db.prepare(`
    UPDATE device_commands
    SET status = ?, sent_at = COALESCE(?, sent_at), response_text = ?,
        response_payload = ?, acked_at = ?, updated_at = ?
    WHERE id = ?
  `).run(status, sentAt, responseText, responseText, ackedAt, nowSql(), id);
}

function configStatusForReply(replyStatus: "pending" | "applied" | "failed"): ConfigStatus {
  if (replyStatus === "applied") return "applied";
  if (replyStatus === "failed") return "failed";
  return "pending";
}

function persistConfigState(
  input: DispatchInput,
  status: ConfigStatus,
  responseText: string | null,
  commandId: string
): void {
  const state = input.configState;
  if (!state) return;
  upsertConfigState({
    imei: input.imei,
    vehicleId: input.vehicleId,
    paramId: state.paramId,
    featureKey: state.featureKey ?? null,
    value: state.value ?? null,
    status,
    commandId,
    requestedBy: input.requestedBy ?? null,
    responseText,
    presetKey: state.presetKey ?? null,
    presetMetadata: state.presetMetadata ?? null,
  });
}

/**
 * Queues a command and dispatches it immediately when the tracker is online.
 * Offline devices keep the command `queued`; `flushQueuedCommandsForImei()`
 * dispatches it on the next telemetry ingest.
 */
export async function dispatchDeviceCommand(input: DispatchInput): Promise<DispatchResult> {
  const device = loadDevice(input.imei);
  const online = isDeviceOnline(device?.last_seen_at);
  const serialized = serializeCommand(input.payload);
  const id = insertCommand(input, serialized);

  // A read has no requested value, so leave the existing desired/applied state
  // untouched until the tracker replies.
  if (input.configState && input.configState.value !== undefined) {
    persistConfigState(input, input.configState.pendingStatus ?? "pending", null, id);
  }

  if (!online) {
    const text = "Device offline — command queued for the next check-in.";
    updateCommand(id, "queued", null, text, null);
    return {
      id,
      row: db.prepare("SELECT * FROM device_commands WHERE id = ?").get(id),
      serialized,
      status: "queued",
      configStatus: input.configState ? input.configState.pendingStatus ?? "pending" : "unknown",
      responseText: text,
      queued: true,
      sentAt: null,
      ackedAt: null,
    };
  }

  const result = await forwardCommand(input.imei, serialized, { commandType: input.commandType, commandId: id });
  const responseText = (result.text || "").slice(0, 1000) || null;
  const reply = parseTrackerReply(responseText);
  let status: string;
  let configStatus: ConfigStatus | "unknown" = input.configState ? input.configState.pendingStatus ?? "pending" : "unknown";
  let sentAt: string | null = null;
  let ackedAt: string | null = null;

  if (result.ok) {
    sentAt = nowSql();
    if (reply.status === "applied") {
      status = "applied";
      ackedAt = sentAt;
      if (input.configState) configStatus = "applied";
    } else if (reply.status === "failed") {
      status = "failed";
      if (input.configState) configStatus = "failed";
    } else {
      status = "sent";
    }
  } else if (result.transportError) {
    // Keep the command queued so the next telemetry check-in retries it.
    status = "queued";
  } else {
    status = "failed";
    if (input.configState) configStatus = "failed";
  }

  const finalText = result.ok
    ? responseText
    : result.transportError
      ? `${responseText} (will retry on next check-in)`
      : responseText
        ? `${responseText} (HTTP ${result.status})`
        : `Command endpoint returned HTTP ${result.status}`;

  updateCommand(id, status, sentAt, finalText, ackedAt);

  if (input.configState && configStatus !== "pending") {
    persistConfigState(input, configStatus as ConfigStatus, finalText, id);
  }

  return {
    id,
    row: db.prepare("SELECT * FROM device_commands WHERE id = ?").get(id),
    serialized,
    status,
    configStatus,
    responseText: finalText,
    queued: status === "queued",
    sentAt,
    ackedAt,
  };
}

const flushing = new Set<string>();

/**
 * Flushes queued commands when a device checks in. Called from the telemetry
 * ingest hook. Returns the number of commands processed.
 */
export async function flushQueuedCommandsForImei(imei: string): Promise<number> {
  if (flushing.has(imei)) return 0;
  flushing.add(imei);
  try {
    const rows = db
      .prepare("SELECT * FROM device_commands WHERE imei = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 50")
      .all(imei) as any[];

    for (const row of rows) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = row.payload_json ? JSON.parse(row.payload_json) : null;
      } catch {
        payload = null;
      }
      const serialized = row.raw_command || (payload ? serializeCommand(payload) : "");
      if (!serialized) {
        updateCommand(row.id, "failed", null, "Cannot dispatch: missing command payload", null);
        continue;
      }

      const result = await forwardCommand(imei, serialized, { commandType: row.command_type, commandId: row.id });
      const responseText = (result.text || "").slice(0, 1000) || null;
      const reply = parseTrackerReply(responseText);

      if (result.ok) {
        const status = reply.status === "applied" ? "applied" : reply.status === "failed" ? "failed" : "sent";
        const sentAt = nowSql();
        const ackedAt = status === "applied" ? sentAt : null;
        updateCommand(row.id, status, sentAt, responseText, ackedAt);
        if (reply.status === "applied" || reply.status === "failed") {
          applyConfigAck(row, responseText);
        }
      } else if (result.transportError) {
        updateCommand(row.id, "queued", null, `${responseText} (will retry on next check-in)`, null);
      } else {
        updateCommand(
          row.id,
          "failed",
          null,
          responseText ? `${responseText} (HTTP ${result.status})` : `Command endpoint returned HTTP ${result.status}`,
          null
        );
      }
    }

    return rows.length;
  } finally {
    flushing.delete(imei);
  }
}
