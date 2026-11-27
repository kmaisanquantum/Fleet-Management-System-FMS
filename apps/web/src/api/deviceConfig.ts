import { apiGet, apiPost } from "./client";
import type { DeviceCommand } from "./telemetry";

export type DeviceConfigValue = string | number | boolean;
export type DeviceConfigStatus = "pending" | "applied" | "failed" | "unknown";

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
  last_applied_at: string | null;
  last_sync_info: string | null;
  last_sync_at: string | null;
  queued_count: number;
  parameters: DeviceConfigParameter[];
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
  get: (imei: string) => apiGet<{ data: DeviceConfig }>(`/devices/${encodeURIComponent(imei)}/config`),
  update: (imei: string, body: DeviceConfigUpdate) =>
    apiPost<{ data: { commands: DeviceCommand[]; results: DeviceConfigResult[] }; message: string }>(
      `/devices/${encodeURIComponent(imei)}/config`,
      body
    ),
  command: (imei: string, body: DeviceCommandAction) =>
    apiPost<{ data: DeviceCommand; message: string }>(`/devices/${encodeURIComponent(imei)}/command`, body),
  bulkConfig: (body: DeviceConfigUpdate & { imeis: string[] }) =>
    apiPost<{ data: { results: BulkConfigResult[] }; message: string }>("/devices/bulk-config", body),
};
