/**
 * Client for the fleet telemetry API (`/api/telemetry`), which is mounted
 * outside the `/api/v1` prefix used by the rest of the FMS API.
 */
const TELEMETRY_BASE = "/api/telemetry";

function authHeader(): Record<string, string> {
  const token = localStorage.getItem("fms_access_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${TELEMETRY_BASE}${path}`, { headers: { ...authHeader() } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || "Request failed");
  }
  return res.json();
}

export interface TelemetryLatest {
  vehicle_id: string;
  vehicle_number: string;
  registration_number: string;
  make: string;
  model: string;
  department: string | null;
  client_id: string | null;
  client_name: string | null;
  lat: number | null;
  lon: number | null;
  fuel_level_pct: number | null;
  recorded_at: string | null;
  computed_status: string | null;
  speed: number | null;
  heading: number | null;
  ignition: number | null;
  sats: number | null;
  fuel_liters: number | null;
  imei: string | null;
  gsm_signal: number | null;
  source: string | null;
  io_json: string | null;
}

export interface TelemetryVehicleSummary {
  vehicle_id: string;
  vehicle_number: string;
  registration_number: string;
  client_id: string | null;
  client_name: string | null;
  distance_km: number;
  fuel_refueled_liters: number;
  fuel_consumed_liters: number;
  fuel_efficiency_l_per_100km: number | null;
  fix_count: number;
  last_fix_at: string | null;
}

export interface TelemetryEvent {
  id: string;
  created_at: string;
  severity: "critical" | "warning" | "info";
  category: string;
  rule_code: string;
  description: string;
  status: string;
  vehicle_id: string | null;
  vehicle_number: string | null;
}

export interface TelemetrySummary {
  from: string;
  to: string;
  clients_scoped: string;
  vehicles: TelemetryVehicleSummary[];
  events: TelemetryEvent[];
  totals: {
    distance_km: number;
    fuel_refueled_liters: number;
    fuel_consumed_liters: number;
    event_count: number;
  };
}

export const telemetryApi = {
  latest: () => getJson<{ data: TelemetryLatest[] }>("/latest"),
  summary: (from: string, to: string) =>
    getJson<{ data: TelemetrySummary }>(
      `/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    ),
  exportCsv: async (from: string, to: string): Promise<Blob> => {
    const res = await fetch(
      `${TELEMETRY_BASE}/export?format=csv&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { ...authHeader() } }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || "Export failed");
    }
    return res.blob();
  },
};
