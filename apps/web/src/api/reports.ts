import { api, getToken, isTokenExpiring, refreshAccessToken } from "./client";

export type ReportType =
  | "trip-mileage"
  | "driver-behaviour"
  | "geofence-idle"
  | "fuel-utilization"
  | "device-health";

export interface ReportColumn {
  key: string;
  label: string;
  format?: "text" | "number" | "decimal" | "date" | "duration" | "percent" | "currency";
}

export interface ReportSection {
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

export interface ReportKpi {
  key: string;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "danger";
}

export interface ReportPeriod {
  fromUtc: string;
  toUtc: string;
  fromPgt: string;
  toPgt: string;
  fromDate: string;
  toDate: string;
  days: number;
}

export interface ReportResult {
  type: ReportType;
  title: string;
  generatedAt: string;
  period: ReportPeriod;
  filters: Record<string, string | undefined>;
  kpis: ReportKpi[];
  sections: ReportSection[];
}

export interface ReportFilters {
  from?: string;
  to?: string;
  vehicleId?: string;
  imei?: string;
  group?: string;
}

export interface ReportOptions {
  report_types: { type: ReportType; title: string; description: string }[];
  vehicles: {
    id: string;
    vehicle_number: string;
    registration_number: string;
    department: string | null;
    client_id: string | null;
    client_name: string | null;
    imei: string | null;
  }[];
  groups: string[];
  recipient: string;
}

export interface MailResult {
  status: "sent" | "failed" | "skipped";
  messageId?: string;
  error?: string;
  recipients: string[];
  cc: string[];
}

export interface AlertSettings {
  smtp: {
    configured: boolean;
    host: string | null;
    port: number;
    secure: boolean;
    from: string;
    authConfigured: boolean;
  };
  recipients: { alert: string; alertCc: string; report: string; reportCc: string };
  thresholds: {
    overspeedKmh: number;
    lowVoltageV: number;
    cooldownSeconds: number;
    offlineMinutes: number;
    offlineCooldownMinutes: number;
    idleMinutes: number;
  };
  toggles: {
    emailAlerts: boolean;
    overspeed: boolean;
    ignition: boolean;
    offline: boolean;
    power: boolean;
    geofence: boolean;
    security: boolean;
  };
  schedule: {
    dailyEnabled: boolean;
    dailyTime: string;
    weeklyEnabled: boolean;
    weeklyTime: string;
    monthlyEnabled: boolean;
    monthlyTime: string;
  };
}

export interface EmailDelivery {
  id: string;
  kind: string;
  recipient: string;
  cc: string | null;
  subject: string;
  status: "sent" | "failed" | "skipped";
  message_id: string | null;
  error: string | null;
  report_type: string | null;
  alert_type: string | null;
  severity: string | null;
  vehicle_number: string | null;
  created_at: string;
}

export interface FleetAlert {
  id: string;
  imei: string;
  vehicle_id: string | null;
  vehicle_number: string | null;
  registration_number: string | null;
  alert_type: string;
  severity: "critical" | "warning" | "info";
  message: string;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  voltage: number | null;
  email_sent: number;
  email_sent_at: string | null;
  email_error: string | null;
  acknowledged: number;
  created_at: string;
}

function queryString(filters: ReportFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function authFetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  let token = getToken();
  if (isTokenExpiring(token)) token = await refreshAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (res.status === 401 && !retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return authFetch(path, init, true);
  }
  return res;
}

export const reportsApi = {
  options: () => api.get<{ data: ReportOptions }>("/reports/options"),
  run: (type: ReportType, filters: ReportFilters) =>
    api.get<{ data: ReportResult }>(`/reports/${type}${queryString(filters)}`),
  email: (type: ReportType, filters: ReportFilters) =>
    api.post<{ data: MailResult; message: string }>(`/reports/${type}/email${queryString(filters)}`, filters),
  csv: async (type: ReportType, filters: ReportFilters): Promise<Blob> => {
    const res = await authFetch(`/reports/${type}${queryString({ ...filters, format: "csv" } as ReportFilters)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || "CSV export failed");
    }
    return res.blob();
  },
};

export const alertSettingsApi = {
  get: () => api.get<{ data: AlertSettings }>("/alert-settings"),
  update: (settings: Partial<AlertSettings>) => api.put<{ data: AlertSettings; message: string }>("/alert-settings", settings),
  testEmail: () => api.post<{ data: MailResult; message: string }>("/alert-settings/test-email"),
  deliveries: (limit = 100) => api.get<{ data: EmailDelivery[] }>(`/alert-settings/deliveries?limit=${limit}`),
  alerts: (limit = 100) => api.get<{ data: FleetAlert[] }>(`/alert-settings/alerts?limit=${limit}`),
  acknowledge: (id: string) => api.patch<{ data: FleetAlert }>(`/alert-settings/alerts/${id}/ack`),
};
