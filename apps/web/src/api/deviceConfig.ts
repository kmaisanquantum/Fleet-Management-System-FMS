import { apiGet, apiPost, getToken } from "./client";
import type { DeviceCommand } from "./telemetry";

export type DeviceConfigValue = string | number | boolean;
export type DeviceConfigStatus = "pending" | "applied" | "failed" | "unknown";

export type TeltonikaFieldType = "number" | "text" | "select" | "boolean" | "time" | "password" | "readonly";

export interface TeltonikaOption {
  value: string;
  label: string;
}

export interface TeltonikaField {
  id: string;
  paramId: number;
  label: string;
  category: string;
  subSection: string;
  type: TeltonikaFieldType;
  options?: TeltonikaOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
  dangerous?: boolean;
  sensitive?: boolean;
  loadByDefault?: boolean;
}

export interface TeltonikaFeature {
  key: string;
  label: string;
  description: string;
  fields: TeltonikaField[];
}

export interface TeltonikaSection {
  key: string;
  label: string;
  description: string;
  kind: "status" | "parameters";
  fields: TeltonikaField[];
  features?: TeltonikaFeature[];
}

export interface TeltonikaRegistry {
  model: string;
  source: string;
  sections: TeltonikaSection[];
  field_count: number;
  load_param_ids: number[];
  dangerous_param_ids: number[];
}

export interface DeviceSummary {
  imei: string;
  device_model: string | null;
  vehicle_id: string | null;
  client_id: string | null;
  last_seen_at: string | null;
  firmware_version: string | null;
  vehicle_number: string | null;
  registration_number: string | null;
  online: boolean;
}

export interface DeviceConfigParameter {
  param_id: number;
  feature_key: string;
  description: string | null;
  unit: string | null;
  /** Latest requested value (kept for backward compatibility). */
  value: string | null;
  desired_value: string | null;
  applied_value: string | null;
  status: DeviceConfigStatus;
  command_id: string | null;
  requested_at: string | null;
  applied_at: string | null;
  response_text: string | null;
  preset_key: string | null;
  preset_metadata: string | null;
}

export interface DeviceConfigPresetParameter {
  key: string;
  feature_key: string;
  label: string;
  param_id: number | null;
  description: string | null;
  unit: string | null;
}

export interface DeviceConfigPreset {
  key: string;
  label: string;
  description: string;
  parameters: DeviceConfigPresetParameter[];
}

export interface DeviceConfigParameterState {
  param_id: number;
  feature_key: string | null;
  value: string | null;
  desired_value: string | null;
  applied_value: string | null;
  status: DeviceConfigStatus;
  command_id: string | null;
  requested_at: string | null;
  applied_at: string | null;
  response_text: string | null;
  preset_key: string | null;
  preset_metadata: string | null;
  updated_at: string | null;
}

export interface DeviceConfig {
  imei: string;
  vehicle_id: string;
  client_id: string | null;
  device_model: string | null;
  vehicle_number: string | null;
  registration_number: string | null;
  last_seen_at: string | null;
  device_last_seen_at: string | null;
  online: boolean;
  firmware_version: string | null;
  config_version: string | null;
  device_info: Record<string, unknown> | null;
  device_info_updated_at: string | null;
  last_applied_at: string | null;
  last_sync_info: string | null;
  last_sync_at: string | null;
  queued_count: number;
  parameters: DeviceConfigParameter[];
  parameter_states: DeviceConfigParameterState[];
  registry_param_count: number;
  presets: DeviceConfigPreset[];
  commands: DeviceCommand[];
  command_history: DeviceCommand[];
}

export interface DeviceConfigUpdate {
  parameters?: { param_id?: number; feature_key?: string; value: DeviceConfigValue }[];
  presets?: Record<string, DeviceConfigValue | Record<string, DeviceConfigValue>>;
  preset?: string;
  value?: DeviceConfigValue;
  values?: Record<string, DeviceConfigValue>;
  read?: (number | string)[];
  param_ids?: number[];
  diagnostic?: "getinfo" | "getgps" | "getver" | "getstatus" | "readio" | "getparam";
  reason?: string;
}

export interface DeviceConfigResult {
  id: string;
  command_type: string;
  command: string;
  status: string;
  config_status: DeviceConfigStatus;
  response_text: string | null;
  queued?: boolean;
}

export interface DeviceCommandAction {
  type?:
    | "getinfo"
    | "getver"
    | "getstatus"
    | "getgps"
    | "readio"
    | "getparam"
    | "setparam"
    | "setdigout"
    | "camreq"
    | "raw";
  command?: string;
  param_id?: number;
  feature_key?: string;
  value?: DeviceConfigValue;
  dout?: 0 | 1 | string | number;
  state?: 0 | 1 | string | number;
  dout_index?: number;
  index?: number;
  timeout?: number;
  channel?: number;
  reason?: string;
  force?: boolean;
  confirm?: boolean;
}

export interface BulkConfigResult {
  imei: string;
  ok: boolean;
  status: string;
  error?: string;
  command_ids?: string[];
  results?: DeviceConfigResult[];
}

export const deviceConfigApi = {
  list: () => apiGet<{ data: DeviceSummary[] }>("/devices"),
  registry: () => apiGet<{ data: TeltonikaRegistry }>("/devices/registry"),
  bridgeDevices: () => apiGet<{ data: unknown }>("/devices/bridge"),
  get: (imei: string) => apiGet<{ data: DeviceConfig }>(`/devices/${encodeURIComponent(imei)}/config`),
  update: (imei: string, body: DeviceConfigUpdate) =>
    apiPost<{ data: { commands: DeviceCommand[]; results: DeviceConfigResult[] }; message: string }>(
      `/devices/${encodeURIComponent(imei)}/config`,
      body
    ),
  command: (imei: string, body: DeviceCommandAction) =>
    apiPost<{ data: DeviceCommand; message: string }>(`/devices/${encodeURIComponent(imei)}/command`, body),
  load: (imei: string, body: { param_ids?: number[]; reason?: string } = {}) =>
    apiPost<{ data: { commands: DeviceConfigResult[]; param_ids: number[] }; message: string }>(
      `/devices/${encodeURIComponent(imei)}/load`,
      body
    ),
  readRecords: (imei: string, body: { reason?: string } = {}) =>
    apiPost<{ data: { commands: DeviceConfigResult[]; latest_record: Record<string, unknown> | null }; message: string }>(
      `/devices/${encodeURIComponent(imei)}/read-records`,
      body
    ),
  reboot: (imei: string, body: { confirm: true; reason?: string }) =>
    apiPost<{ data: DeviceConfigResult; message: string }>(`/devices/${encodeURIComponent(imei)}/reboot`, body),
  bulkConfig: (body: DeviceConfigUpdate & { imeis: string[] }) =>
    apiPost<{ data: { results: BulkConfigResult[] }; message: string }>("/devices/bulk-config", body),
  /**
   * Reads the SSE snapshot stream with a normal fetch request so the bearer
   * token stays in the Authorization header instead of a URL query string.
   */
  stream: async (imei: string, signal: AbortSignal, onSnapshot: (snapshot: unknown) => void) => {
    const token = getToken();
    const res = await fetch(`/api/v1/devices/${encodeURIComponent(imei)}/events`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Live stream unavailable (HTTP ${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data) {
          try {
            onSnapshot(JSON.parse(data));
          } catch {
            // Ignore malformed frames; the next snapshot will retry.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  },
};
