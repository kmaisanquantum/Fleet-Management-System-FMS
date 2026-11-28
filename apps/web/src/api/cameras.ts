import { apiGet, apiPost, apiPut, apiDel } from "./client";

export type CameraMode = "snapshot" | "mjpeg" | "hls" | "webrtc";
export type CameraScope = "depot" | "vehicle";

export interface CameraFeed {
  id: string;
  name: string;
  scope: CameraScope;
  depot: string | null;
  vehicle_id: string | null;
  vehicle_number: string | null;
  registration_number: string | null;
  department: string | null;
  imei: string | null;
  stream_url: string | null;
  snapshot_url: string | null;
  mode: CameraMode;
  poll_interval_sec: number;
  is_active: boolean;
  last_seen_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  client_id: string | null;
  client_name: string | null;
  online: boolean;
  status: "online" | "offline" | "unknown";
  created_at: string;
  updated_at: string | null;
}

export interface CameraSummary {
  total: number;
  active: number;
  inactive: number;
  online: number;
  offline: number;
  with_errors: number;
}

export interface CameraOptions {
  vehicles: {
    id: string;
    vehicle_number: string;
    registration_number: string;
    department: string | null;
    imei: string | null;
  }[];
  depots: string[];
}

export interface CameraFeedInput {
  name?: string;
  scope?: CameraScope;
  depot?: string | null;
  vehicleId?: string | null;
  imei?: string | null;
  streamUrl?: string | null;
  snapshotUrl?: string | null;
  mode?: CameraMode;
  pollIntervalSec?: number;
  isActive?: boolean;
}

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const camerasApi = {
  options: () => apiGet<{ data: CameraOptions }>("/cameras/options"),
  summary: () => apiGet<{ data: CameraSummary }>("/cameras/summary"),
  list: (params: { scope?: string; vehicleId?: string; depot?: string; active?: string; search?: string } = {}) =>
    apiGet<{ data: CameraFeed[] }>(`/cameras${queryString(params)}`),
  create: (body: CameraFeedInput) => apiPost<{ data: CameraFeed }>("/cameras", body),
  update: (id: string, body: Partial<CameraFeedInput>) => apiPut<{ data: CameraFeed }>(`/cameras/${encodeURIComponent(id)}`, body),
  remove: (id: string) => apiDel<{ message: string }>(`/cameras/${encodeURIComponent(id)}`),
  probe: (id: string) =>
    apiPost<{ data: { ok: boolean; status: number; error: string | null; lastSeenAt: string | null; feed: CameraFeed | null } }>(
      `/cameras/${encodeURIComponent(id)}/probe`
    ),
};
