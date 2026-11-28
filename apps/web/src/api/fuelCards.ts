import { apiGet, apiPost, apiPut, apiDel } from "./client";

export interface FuelCard {
  id: string;
  card_number: string;
  provider: string | null;
  vehicle_id: string | null;
  assigned_vehicle_id: string | null;
  assigned_imei: string | null;
  assigned_driver_id: string | null;
  authorised_driver_id: string | null;
  resolved_vehicle_id: string | null;
  vehicle_number: string | null;
  registration_number: string | null;
  department: string | null;
  driver_name: string | null;
  status: "active" | "suspended" | "blocked" | "cancelled" | "lost";
  daily_limit_liters: number | null;
  monthly_limit_amount: number | null;
  notes: string | null;
  transaction_count: number;
  flagged_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface FuelCardTransaction {
  id: string;
  fuel_card_id: string | null;
  card_number: string;
  vehicle_id: string | null;
  imei: string | null;
  transaction_at: string;
  station_name: string | null;
  station_lat: number | null;
  station_lon: number | null;
  liters: number;
  amount: number | null;
  currency: string;
  gps_lat: number | null;
  gps_lon: number | null;
  distance_km: number | null;
  status: "matched" | "flagged";
  flag_reason: string | null;
  provider?: string | null;
  vehicle_number?: string | null;
  registration_number?: string | null;
}

export interface FuelCardSummary {
  cards: {
    total: number;
    active: number;
    suspended: number;
    lost: number;
    by_status: Record<string, number>;
  };
  transactions: {
    total: number;
    flagged: number;
    matched: number;
    liters: number;
    amount: number;
  };
  recent_flagged: FuelCardTransaction[];
}

export interface FuelCardOptions {
  vehicles: {
    id: string;
    vehicle_number: string;
    registration_number: string;
    department: string | null;
    imei: string | null;
  }[];
  drivers: { id: string; name: string; employee_number: string; department: string | null }[];
  depots: string[];
}

export interface FuelCardInput {
  cardNumber?: string;
  provider?: string | null;
  vehicleId?: string | null;
  imei?: string | null;
  driverId?: string | null;
  status?: FuelCard["status"];
  dailyLimitLiters?: number | null;
  monthlyLimitAmount?: number | null;
  notes?: string | null;
}

export interface FuelCardSwipeInput {
  transactionAt?: string;
  vehicleId?: string;
  imei?: string;
  stationName?: string;
  stationLat?: number;
  stationLon?: number;
  liters: number;
  amount?: number;
  currency?: string;
  gpsLat?: number;
  gpsLon?: number;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const fuelCardsApi = {
  options: () => apiGet<{ data: FuelCardOptions }>("/fuel-cards/options"),
  summary: (params: { from?: string; to?: string } = {}) =>
    apiGet<{ data: FuelCardSummary }>(`/fuel-cards/summary${queryString(params)}`),
  list: (params: { status?: string; vehicleId?: string; search?: string } = {}) =>
    apiGet<{ data: FuelCard[] }>(`/fuel-cards${queryString(params)}`),
  transactions: (params: { cardId?: string; vehicleId?: string; status?: string; from?: string; to?: string; limit?: number } = {}) =>
    apiGet<{ data: FuelCardTransaction[] }>(`/fuel-cards/transactions${queryString(params)}`),
  create: (body: FuelCardInput) => apiPost<{ data: FuelCard }>("/fuel-cards", body),
  update: (id: string, body: Partial<FuelCardInput>) => apiPut<{ data: FuelCard }>(`/fuel-cards/${encodeURIComponent(id)}`, body),
  remove: (id: string) => apiDel<{ message: string }>(`/fuel-cards/${encodeURIComponent(id)}`),
  swipe: (id: string, body: FuelCardSwipeInput) =>
    apiPost<{ data: FuelCardTransaction; reconciliation: { status: string; alertsCreated: number } }>(
      `/fuel-cards/${encodeURIComponent(id)}/swipe`,
      body
    ),
  importCsv: (csv: string) =>
    apiPost<{ data: { imported: number; duplicates: number; flagged: number; errors: { row: number; error: string }[] } }>(
      "/fuel-cards/import",
      { csv }
    ),
};
