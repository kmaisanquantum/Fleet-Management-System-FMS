import { v4 as uuid } from "uuid";
import { db } from "../db";

/**
 * Remote FMB125 configuration helpers.
 *
 * The MeshSat gateway delivers Codec 12 commands to the tracker over its next
 * TCP session. Configuration writes are therefore asynchronous: a command is
 * `pending` until MeshSat reports the tracker's reply through the existing
 * `/api/telemetry/commands/ack` callback. The latest per-parameter state is
 * kept in `device_config_state`; the full command trail remains in
 * `device_commands`.
 */

export type ConfigValue = string | number | boolean;
export type ConfigStatus = "pending" | "applied" | "failed";

export interface ConfigPresetParameter {
  /** Key used inside a preset `values` object. */
  key: string;
  feature_key: string;
  label: string;
}

export interface ConfigPreset {
  key: string;
  label: string;
  description: string;
  parameters: ConfigPresetParameter[];
}

/**
 * Operator-facing presets. The parameter IDs are resolved through `param_map`
 * so a firmware-specific ID can be corrected in Settings without a code change.
 */
export const CONFIG_PRESETS: ConfigPreset[] = [
  {
    key: "reporting_interval",
    label: "Reporting interval",
    description: "Periodic data-send interval in seconds.",
    parameters: [{ key: "value", feature_key: "reporting_interval", label: "Interval (s)" }],
  },
  {
    key: "ignition_source",
    label: "Ignition source",
    description: "FMB125 ignition source value (match the vehicle wiring).",
    parameters: [{ key: "value", feature_key: "ignition_source", label: "Source value" }],
  },
  {
    key: "data_acquisition",
    label: "Data acquisition",
    description: "Ignition-on and ignition-off acquisition periods in seconds.",
    parameters: [
      { key: "ignition_on", feature_key: "data_acquisition_ignition_on", label: "Ignition ON (s)" },
      { key: "ignition_off", feature_key: "data_acquisition_ignition_off", label: "Ignition OFF (s)" },
    ],
  },
  {
    key: "digital_output_control",
    label: "Digital output control",
    description: "DOUT1 state (0 = off, 1 = on).",
    parameters: [{ key: "value", feature_key: "digital_output_control", label: "DOUT1" }],
  },
];

export interface ResolvedParameter {
  param_id: number;
  feature_key: string | null;
  description: string | null;
  unit: string | null;
  value: ConfigValue;
  /** Preset that produced this write, when applicable. */
  preset_key?: string | null;
  /** JSON metadata describing the preset application. */
  preset_metadata?: string | null;
}

export interface TrackerReply {
  status: "pending" | "applied" | "failed";
  value?: string;
  error?: string;
}

interface ParamMapRow {
  param_id: number;
  description: string | null;
  unit: string | null;
}

/** Looks up a feature key in the configurable Teltonika parameter map. */
export function lookupFeatureParam(featureKey: string): ParamMapRow | undefined {
  return db
    .prepare("SELECT param_id, description, unit FROM param_map WHERE feature_key = ? ORDER BY param_id LIMIT 1")
    .get(featureKey) as ParamMapRow | undefined;
}

/** Looks up the optional description/unit for a raw parameter ID. */
export function lookupParamId(paramId: number): ParamMapRow | undefined {
  return db
    .prepare("SELECT param_id, description, unit FROM param_map WHERE param_id = ? ORDER BY feature_key LIMIT 1")
    .get(paramId) as ParamMapRow | undefined;
}

export function findPreset(key: string): ConfigPreset | undefined {
  return CONFIG_PRESETS.find((p) => p.key === key);
}

/**
 * Expands a preset value into concrete parameter writes.
 *
 * A single-parameter preset accepts a scalar (`value`). A multi-parameter
 * preset accepts an object keyed by the preset parameter keys (for example
 * `{ ignition_on: 10, ignition_off: 60 }`).
 */
export function resolvePreset(
  preset: ConfigPreset,
  value: ConfigValue | Record<string, ConfigValue> | undefined
): { parameters: ResolvedParameter[]; error?: string } {
  if (value === undefined) return { parameters: [], error: `Preset '${preset.key}' requires a value` };

  const scalar = typeof value !== "object";
  if (scalar && preset.parameters.length !== 1) {
    return { parameters: [], error: `Preset '${preset.key}' requires a values object` };
  }

  const parameters: ResolvedParameter[] = [];
  for (const p of preset.parameters) {
    const raw = scalar ? value : (value as Record<string, ConfigValue>)[p.key] ?? (value as Record<string, ConfigValue>)[p.feature_key];
    if (raw === undefined) return { parameters: [], error: `Preset '${preset.key}' is missing '${p.key}'` };
    const mapped = lookupFeatureParam(p.feature_key);
    if (!mapped) {
      return { parameters: [], error: `No parameter map entry for '${p.feature_key}'. Add it in Settings → Teltonika Parameter Map.` };
    }
    parameters.push({
      param_id: mapped.param_id,
      feature_key: p.feature_key,
      description: mapped.description,
      unit: mapped.unit,
      value: raw,
      preset_key: preset.key,
      preset_metadata: JSON.stringify({ preset: preset.key, values: value }),
    });
  }
  return { parameters };
}

/** Resolves a raw `{ param_id | feature_key, value }` update. */
export function resolveRawParameter(input: {
  param_id?: number;
  feature_key?: string;
  value: ConfigValue;
}): { parameter?: ResolvedParameter; error?: string } {
  if (input.param_id === undefined && !input.feature_key) {
    return { error: "Each parameter needs a param_id or feature_key" };
  }
  if (input.param_id !== undefined) {
    const mapped = lookupParamId(input.param_id);
    return {
      parameter: {
        param_id: input.param_id,
        feature_key: input.feature_key ?? null,
        description: mapped?.description ?? null,
        unit: mapped?.unit ?? null,
        value: input.value,
      },
    };
  }
  const mapped = lookupFeatureParam(input.feature_key!);
  if (!mapped) {
    return { error: `No parameter map entry for '${input.feature_key}'. Add it in Settings → Teltonika Parameter Map.` };
  }
  return {
    parameter: {
      param_id: mapped.param_id,
      feature_key: input.feature_key!,
      description: mapped.description,
      unit: mapped.unit,
      value: input.value,
    },
  };
}

/** Resolves a read target (numeric ID or feature key). */
export function resolveReadTarget(target: number | string): { param_id?: number; error?: string } {
  if (typeof target === "number") return { param_id: target };
  const mapped = lookupFeatureParam(target);
  if (!mapped) {
    return { error: `No parameter map entry for '${target}'. Add it in Settings → Teltonika Parameter Map.` };
  }
  return { param_id: mapped.param_id };
}

const FAILURE_RE = /\b(error|failed|failure|invalid|unsupported|not\s+supported|reject(?:ed)?|denied|timeout)\b/i;
const SUCCESS_RE = /\b(applied|acknowledged|ack|ok|success|done)\b/i;

/** Parses a tracker reply (raw text or a MeshSat JSON envelope). */
export function parseTrackerReply(reply: string | null | undefined): TrackerReply {
  if (!reply) return { status: "pending" };
  const text = String(reply).trim();
  if (!text) return { status: "pending" };

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const status = String(parsed.status ?? "").toLowerCase();
    const value =
      parsed.value !== undefined && parsed.value !== null
        ? String(parsed.value)
        : parsed.response !== undefined && parsed.response !== null
          ? String(parsed.response)
          : parsed.reply !== undefined && parsed.reply !== null
            ? String(parsed.reply)
            : undefined;
    if (/^(applied|acknowledged|ack|ok|success|done)$/.test(status)) return { status: "applied", value };
    if (/^(failed|failure|error|rejected|invalid)$/.test(status)) return { status: "failed", error: text };
    if (value) return parseTrackerReply(value);
  } catch {
    // Not JSON: fall through to text matching.
  }

  if (FAILURE_RE.test(text)) return { status: "failed", error: text };
  if (SUCCESS_RE.test(text)) return { status: "applied", value: extractParamValue(text) };
  return { status: "pending" };
}

/** Extracts a `param_id:value` / `param_id=value` value from a tracker reply. */
export function extractParamValue(text: string, paramId?: number): string | undefined {
  const idPattern = paramId !== undefined ? String(paramId) : "\\d+";
  const match = text.match(new RegExp(`(?:${idPattern})\\s*[:=]\\s*([^\\s,;]+)`));
  return match?.[1];
}

interface ConfigCommandRow {
  id: string;
  imei: string;
  vehicle_id: string | null;
  command_type: string;
  payload_json: string | null;
}

interface ConfigStateInput {
  imei: string;
  vehicleId: string | null;
  paramId: number;
  featureKey?: string | null;
  value?: ConfigValue | null;
  status: ConfigStatus;
  commandId?: string | null;
  requestedBy?: string | null;
  responseText?: string | null;
  /** Preset that produced this write, when applicable. */
  presetKey?: string | null;
  /** JSON metadata describing the preset application. */
  presetMetadata?: string | null;
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

/** Creates or updates the latest known state for one IMEI parameter. */
export function upsertConfigState(input: ConfigStateInput): void {
  const existing = db
    .prepare(`
      SELECT id, requested_at, applied_at, applied_value, feature_key, preset_key, preset_metadata
      FROM device_config_state WHERE imei = ? AND param_id = ?
    `)
    .get(input.imei, input.paramId) as
    | {
        id: string;
        requested_at: string | null;
        applied_at: string | null;
        applied_value: string | null;
        feature_key: string | null;
        preset_key: string | null;
        preset_metadata: string | null;
      }
    | undefined;
  const timestamp = nowSql();
  const value = input.value === undefined || input.value === null ? null : String(input.value);
  const requestedAt = input.status === "pending" ? timestamp : existing?.requested_at ?? timestamp;
  const appliedAt = input.status === "applied" ? timestamp : existing?.applied_at ?? null;
  const appliedValue = input.status === "applied" ? value : existing?.applied_value ?? null;
  const featureKey = input.featureKey !== undefined ? input.featureKey : existing?.feature_key ?? null;
  const presetKey = input.presetKey !== undefined ? input.presetKey : existing?.preset_key ?? null;
  const presetMetadata = input.presetMetadata !== undefined ? input.presetMetadata : existing?.preset_metadata ?? null;

  if (existing) {
    db.prepare(`
      UPDATE device_config_state
      SET vehicle_id = ?, feature_key = ?, value = ?, desired_value = ?, applied_value = ?,
          status = ?, command_id = ?, requested_by = ?, requested_at = ?, applied_at = ?,
          response_text = ?, preset_key = ?, preset_metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.vehicleId,
      featureKey,
      value,
      value,
      appliedValue,
      input.status,
      input.commandId ?? null,
      input.requestedBy ?? null,
      requestedAt,
      appliedAt,
      input.responseText ?? null,
      presetKey,
      presetMetadata,
      timestamp,
      existing.id
    );
    return;
  }

  db.prepare(`
    INSERT INTO device_config_state
      (id, imei, vehicle_id, param_id, feature_key, value, desired_value, applied_value,
       status, command_id, requested_by, requested_at, applied_at, response_text,
       preset_key, preset_metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    input.imei,
    input.vehicleId,
    input.paramId,
    featureKey,
    value,
    value,
    appliedValue,
    input.status,
    input.commandId ?? null,
    input.requestedBy ?? null,
    timestamp,
    appliedAt,
    input.responseText ?? null,
    presetKey,
    presetMetadata,
    timestamp,
    timestamp
  );
}

/**
 * Applies a tracker ack to the config state. Called by the command ack route;
 * non-config commands are ignored.
 */
export function applyConfigAck(command: ConfigCommandRow, reply: string | null): ConfigStatus | null {
  const payload = parsePayload(command);
  if (!payload) return null;
  const paramId = typeof payload.param_id === "number" ? payload.param_id : undefined;
  if (paramId === undefined) return null;

  const parsed = parseTrackerReply(reply);
  const status: ConfigStatus = parsed.status === "failed" ? "failed" : "applied";
  const existing = db
    .prepare("SELECT value, desired_value, applied_value, feature_key FROM device_config_state WHERE imei = ? AND param_id = ?")
    .get(command.imei, paramId) as
    | { value: string | null; desired_value: string | null; applied_value: string | null; feature_key: string | null }
    | undefined;

  const value =
    payload.type === "setparam"
      ? (payload.value as ConfigValue)
      : parsed.value ?? existing?.applied_value ?? existing?.desired_value ?? existing?.value ?? null;

  upsertConfigState({
    imei: command.imei,
    vehicleId: command.vehicle_id,
    paramId,
    featureKey: typeof payload.feature_key === "string" ? payload.feature_key : existing?.feature_key ?? null,
    value,
    status,
    commandId: command.id,
    responseText: reply ?? null,
  });
  return status;
}

function parsePayload(command: ConfigCommandRow): Record<string, unknown> | null {
  if (!command.payload_json) return null;
  try {
    return JSON.parse(command.payload_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface DeviceInfoSnapshot {
  firmware_version: string | null;
  updated_at: string | null;
  info: Record<string, unknown> | null;
}

/** Latest persisted tracker identity reply for an IMEI. */
export function getDeviceInfoSnapshot(imei: string): DeviceInfoSnapshot {
  const row = db
    .prepare("SELECT firmware_version, device_info_json, device_info_updated_at FROM gps_devices WHERE device_identifier = ?")
    .get(imei) as
    | { firmware_version: string | null; device_info_json: string | null; device_info_updated_at: string | null }
    | undefined;
  if (!row) return { firmware_version: null, updated_at: null, info: null };

  let info: Record<string, unknown> | null = null;
  if (row.device_info_json) {
    try {
      const parsed = JSON.parse(row.device_info_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) info = parsed as Record<string, unknown>;
    } catch {
      info = { raw: row.device_info_json };
    }
  }
  return { firmware_version: row.firmware_version, updated_at: row.device_info_updated_at, info };
}

/** Extracts a Teltonika firmware string such as `03.25.15 Rev:32`. */
export function extractFirmwareVersion(reply: string): string | null {
  const match = reply.match(/\b0\d\.\d{2}\.\d{2}(?:\s*Rev[:.]?\s*\d+)?/i);
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

/**
 * Persists a tracker identity reply (`getinfo`, `getver`, `getstatus`, `getio`)
 * so the configurator header can render firmware and device details without
 * replaying the command log.
 */
export function recordDeviceInfoReply(imei: string, kind: string, reply: string | null): void {
  if (!reply) return;
  const row = db
    .prepare("SELECT firmware_version, device_info_json FROM gps_devices WHERE device_identifier = ?")
    .get(imei) as { firmware_version: string | null; device_info_json: string | null } | undefined;
  if (!row) return;

  let info: Record<string, unknown> = {};
  if (row.device_info_json) {
    try {
      const parsed = JSON.parse(row.device_info_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) info = parsed as Record<string, unknown>;
    } catch {
      info = { raw: row.device_info_json };
    }
  }

  let value: unknown = reply;
  try {
    value = JSON.parse(reply);
  } catch {
    // Plain-text tracker reply.
  }

  const timestamp = nowSql();
  const firmware = extractFirmwareVersion(reply) ?? row.firmware_version ?? null;
  info[kind] = value;
  info.last_reply_kind = kind;
  info.last_reply_at = timestamp;

  db.prepare(`
    UPDATE gps_devices
    SET firmware_version = ?, device_info_json = ?, device_info_updated_at = ?, updated_at = ?
    WHERE device_identifier = ?
  `).run(firmware, JSON.stringify(info), timestamp, timestamp, imei);
}
