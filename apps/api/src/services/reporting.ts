import { db } from "../db";
import { getBusinessRuleNumber } from "../routes/settings";
import { formatPgt } from "./email";

export type ReportType =
  | "trip-mileage"
  | "driver-behaviour"
  | "geofence-idle"
  | "fuel-utilization"
  | "fuel-cards"
  | "device-health";

export interface ReportFilters {
  from?: string;
  to?: string;
  vehicleId?: string;
  imei?: string;
  group?: string;
}

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
  filters: ReportFilters;
  kpis: ReportKpi[];
  sections: ReportSection[];
}

export const REPORT_TYPES: { type: ReportType; title: string; description: string }[] = [
  {
    type: "trip-mileage",
    title: "Trip & Mileage Summary",
    description: "Start/end locations, distance, driving and idle duration, max/avg speed.",
  },
  {
    type: "driver-behaviour",
    title: "Overspeeding & Driver Behaviour",
    description: "Speed threshold breaches, harsh acceleration, braking and cornering events.",
  },
  {
    type: "geofence-idle",
    title: "Geofence Entry/Exit & Idle Exceptions",
    description: "Zone dwell times, geofence breaches and excessive idling.",
  },
  {
    type: "fuel-utilization",
    title: "Fuel & Utilization",
    description: "Fuel logs, estimated consumption and vehicle utilization percentage.",
  },
  {
    type: "fuel-cards",
    title: "Fuel Card Reconciliation",
    description: "Card swipes matched against vehicle GPS, limits and card status, with flagged anomalies.",
  },
  {
    type: "device-health",
    title: "Device Health & Command Audit",
    description: "Uptime, voltage drops, Codec 12 commands and configuration changes.",
  },
];

export function isReportType(value: string): value is ReportType {
  return REPORT_TYPES.some((item) => item.type === value);
}

export function reportTitle(type: ReportType): string {
  return REPORT_TYPES.find((item) => item.type === type)?.title ?? type;
}

/* ------------------------------------------------------------------ *
 * Period handling (Port Moresby / UTC+10)
 * ------------------------------------------------------------------ */

const PGT_OFFSET = "+10:00";

function sqlUtc(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function pgtInputToDate(value: string, endOfDay = false): Date {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T${endOfDay ? "23:59:59" : "00:00:00"}${PGT_OFFSET}`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    return new Date(`${raw}:00${PGT_OFFSET}`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) {
    return new Date(`${raw}${PGT_OFFSET}`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid report date: ${value}`);
  return parsed;
}

export function normalizeReportPeriod(from?: string, to?: string): ReportPeriod {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromDate = from ? pgtInputToDate(from) : defaultFrom;
  const toDate = to ? pgtInputToDate(to, true) : now;
  if (fromDate.getTime() > toDate.getTime()) throw new Error("Report start must be before report end");

  const fromPgt = new Date(fromDate.getTime() + 10 * 60 * 60 * 1000);
  const toPgt = new Date(toDate.getTime() + 10 * 60 * 60 * 1000);
  const days = Math.max(1, Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)));
  return {
    fromUtc: sqlUtc(fromDate),
    toUtc: sqlUtc(toDate),
    fromPgt: `${fromPgt.toISOString().replace("T", " ").slice(0, 19)} PGT`,
    toPgt: `${toPgt.toISOString().replace("T", " ").slice(0, 19)} PGT`,
    fromDate: fromPgt.toISOString().slice(0, 10),
    toDate: toPgt.toISOString().slice(0, 10),
    days,
  };
}

/* ------------------------------------------------------------------ *
 * Shared query helpers
 * ------------------------------------------------------------------ */

interface VehicleRow {
  id: string;
  vehicle_number: string;
  registration_number: string;
  make: string;
  model: string;
  department: string | null;
  client_id: string | null;
  client_name: string | null;
  current_odometer: number | null;
  tank_capacity_litres: number | null;
  expected_km_per_l: number | null;
  last_seen_at: string | null;
  current_latitude: number | null;
  current_longitude: number | null;
}

interface GeofenceRow {
  id: string;
  name: string;
  client_id: string | null;
  lat: number;
  lon: number;
  radius_meters: number;
}

interface PositionRow {
  recorded_at: string;
  lat: number;
  lon: number;
  speed: number | null;
  ignition: number | null;
  odometer_km: number | null;
  fuel_liters: number | null;
  ext_voltage_v: number | null;
  int_battery_v: number | null;
  io_json: string | null;
}

function vehicleWhere(filters: ReportFilters, scopes: string[] | null): { sql: string; params: unknown[] } {
  const clauses = ["v.status != 'disposed'"];
  const params: unknown[] = [];
  if (filters.vehicleId) {
    clauses.push("v.id = ?");
    params.push(filters.vehicleId);
  }
  if (filters.imei) {
    clauses.push("EXISTS (SELECT 1 FROM gps_devices gd WHERE gd.vehicle_id = v.id AND gd.device_identifier = ?)");
    params.push(filters.imei);
  }
  if (filters.group) {
    clauses.push("(v.department = ? OR c.name = ? OR v.client_id = ?)");
    params.push(filters.group, filters.group, filters.group);
  }
  if (scopes && scopes.length > 0) {
    clauses.push(`v.client_id IN (${scopes.map(() => "?").join(", ")})`);
    params.push(...scopes);
  }
  return { sql: clauses.join(" AND "), params };
}

function loadVehicles(filters: ReportFilters, scopes: string[] | null): VehicleRow[] {
  const where = vehicleWhere(filters, scopes);
  return db.prepare(`
    SELECT v.id, v.vehicle_number, v.registration_number, v.make, v.model, v.department,
           v.client_id, c.name AS client_name, v.current_odometer, v.tank_capacity_litres,
           v.expected_km_per_l, v.last_seen_at, v.current_latitude, v.current_longitude
    FROM vehicles v
    LEFT JOIN clients c ON c.id = v.client_id
    WHERE ${where.sql}
    ORDER BY v.vehicle_number ASC
  `).all(...where.params) as VehicleRow[];
}

function loadGeofences(scopes: string[] | null): GeofenceRow[] {
  let sql = "SELECT id, name, client_id, lat, lon, radius_meters FROM geofences WHERE status = 'active'";
  const params: unknown[] = [];
  if (scopes && scopes.length > 0) {
    sql += ` AND (client_id IS NULL OR client_id IN (${scopes.map(() => "?").join(", ")}))`;
    params.push(...scopes);
  }
  return db.prepare(sql).all(...params) as GeofenceRow[];
}

function loadPositions(vehicleId: string, period: ReportPeriod): PositionRow[] {
  const telemetry = db.prepare(`
    SELECT recorded_at, lat, lon, speed_kmh AS speed, ignition, odometer_km, fuel_liters,
           ext_voltage_v, int_battery_v, io_json
    FROM telemetry_records
    WHERE vehicle_id = ? AND datetime(recorded_at) >= datetime(?) AND datetime(recorded_at) <= datetime(?)
      AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY recorded_at ASC
  `).all(vehicleId, period.fromUtc, period.toUtc) as PositionRow[];
  if (telemetry.length > 0) return telemetry;

  return db.prepare(`
    SELECT recorded_at, lat, lon, speed, ignition, odometer AS odometer_km, fuel_liters,
           external_voltage_mv / 1000.0 AS ext_voltage_v, NULL AS int_battery_v, io_json
    FROM gps_positions
    WHERE vehicle_id = ? AND datetime(recorded_at) >= datetime(?) AND datetime(recorded_at) <= datetime(?)
    ORDER BY recorded_at ASC
  `).all(vehicleId, period.fromUtc, period.toUtc) as PositionRow[];
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function secondsBetween(a: string, b: string): number {
  const start = new Date(a.replace(" ", "T") + (a.includes("T") ? "" : "Z")).getTime();
  const end = new Date(b.replace(" ", "T") + (b.includes("T") ? "" : "Z")).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, (end - start) / 1000);
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtNum(value: unknown, digits = 1): string {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : "—";
}

function locationLabel(lat: number, lon: number, fences: GeofenceRow[]): string {
  for (const fence of fences) {
    if (haversineKm(lat, lon, fence.lat, fence.lon) * 1000 <= fence.radius_meters) return fence.name;
  }
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function round(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

/* ------------------------------------------------------------------ *
 * Trip derivation
 * ------------------------------------------------------------------ */

interface DerivedTrip {
  vehicleId: string;
  vehicleNumber: string;
  registrationNumber: string;
  startAt: string;
  endAt: string;
  startLocation: string;
  endLocation: string;
  distanceKm: number;
  drivingSeconds: number;
  idleSeconds: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
}

function deriveTrips(vehicle: VehicleRow, positions: PositionRow[], fences: GeofenceRow[]): DerivedTrip[] {
  if (positions.length === 0) return [];
  const trips: DerivedTrip[] = [];
  let current: PositionRow[] = [];

  const close = () => {
    if (current.length < 2) {
      current = [];
      return;
    }
    let distance = 0;
    let driving = 0;
    let idle = 0;
    let maxSpeed = 0;
    for (let i = 1; i < current.length; i++) {
      const prev = current[i - 1];
      const next = current[i];
      distance += haversineKm(prev.lat, prev.lon, next.lat, next.lon);
      const dt = secondsBetween(prev.recorded_at, next.recorded_at);
      if ((prev.speed ?? 0) > 3 || prev.ignition === 1) driving += dt;
      else idle += dt;
      maxSpeed = Math.max(maxSpeed, prev.speed ?? 0, next.speed ?? 0);
    }
    const movingSeconds = driving + idle;
    trips.push({
      vehicleId: vehicle.id,
      vehicleNumber: vehicle.vehicle_number,
      registrationNumber: vehicle.registration_number,
      startAt: current[0].recorded_at,
      endAt: current[current.length - 1].recorded_at,
      startLocation: locationLabel(current[0].lat, current[0].lon, fences),
      endLocation: locationLabel(current[current.length - 1].lat, current[current.length - 1].lon, fences),
      distanceKm: round(distance),
      drivingSeconds: Math.round(driving),
      idleSeconds: Math.round(idle),
      maxSpeedKmh: round(maxSpeed),
      avgSpeedKmh: movingSeconds > 0 ? round(distance / (movingSeconds / 3600)) : 0,
    });
    current = [];
  };

  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    const previous = positions[i - 1];
    const moving = (position.speed ?? 0) > 3 || position.ignition === 1;
    const gapSeconds = previous ? secondsBetween(previous.recorded_at, position.recorded_at) : 0;
    const ignitionOff = previous?.ignition === 1 && position.ignition === 0;
    if (current.length > 0 && (gapSeconds > 30 * 60 || ignitionOff)) close();
    if (moving) current.push(position);
    else if (current.length > 0) {
      current.push(position);
      close();
    }
  }
  close();
  return trips;
}

/* ------------------------------------------------------------------ *
 * Report builders
 * ------------------------------------------------------------------ */

function buildTripMileage(vehicles: VehicleRow[], period: ReportPeriod, fences: GeofenceRow[], filters: ReportFilters, scopes: string[] | null): ReportResult {
  const summaryRows: Record<string, unknown>[] = [];
  const tripRows: Record<string, unknown>[] = [];
  let totalDistance = 0;
  let totalDriving = 0;
  let totalIdle = 0;
  let totalTrips = 0;

  for (const vehicle of vehicles) {
    const positions = loadPositions(vehicle.id, period);
    const trips = deriveTrips(vehicle, positions, fences);
    totalTrips += trips.length;
    const distance = trips.reduce((sum, trip) => sum + trip.distanceKm, 0);
    const driving = trips.reduce((sum, trip) => sum + trip.drivingSeconds, 0);
    const idle = trips.reduce((sum, trip) => sum + trip.idleSeconds, 0);
    const maxSpeed = trips.reduce((max, trip) => Math.max(max, trip.maxSpeedKmh), 0);
    totalDistance += distance;
    totalDriving += driving;
    totalIdle += idle;
    summaryRows.push({
      vehicle: vehicle.vehicle_number,
      registration: vehicle.registration_number,
      trips: trips.length,
      distance_km: round(distance),
      driving_time: fmtDuration(driving),
      idle_time: fmtDuration(idle),
      max_speed_kmh: round(maxSpeed),
      avg_speed_kmh: driving + idle > 0 ? round(distance / ((driving + idle) / 3600)) : 0,
      first_start: trips.length ? trips[0].startAt : null,
      last_end: trips.length ? trips[trips.length - 1].endAt : null,
    });
    for (const trip of trips) {
      tripRows.push({
        vehicle: trip.vehicleNumber,
        registration: trip.registrationNumber,
        start_at: trip.startAt,
        end_at: trip.endAt,
        start_location: trip.startLocation,
        end_location: trip.endLocation,
        distance_km: trip.distanceKm,
        driving_time: fmtDuration(trip.drivingSeconds),
        idle_time: fmtDuration(trip.idleSeconds),
        max_speed_kmh: trip.maxSpeedKmh,
        avg_speed_kmh: trip.avgSpeedKmh,
      });
    }
  }

  const manualWhere = vehicleWhere(filters, scopes);
  const manualRows = db.prepare(`
    SELECT vt.date, v.vehicle_number AS vehicle, v.registration_number AS registration,
           vt.start_location, vt.destination, vt.total_km, vt.time_out, vt.time_in
    FROM vehicle_trips vt
    JOIN vehicles v ON v.id = vt.vehicle_id
    LEFT JOIN clients c ON c.id = v.client_id
    WHERE ${manualWhere.sql} AND vt.date >= ? AND vt.date <= ?
    ORDER BY vt.date DESC
  `).all(...manualWhere.params, period.fromDate, period.toDate) as Record<string, unknown>[];

  return {
    type: "trip-mileage",
    title: reportTitle("trip-mileage"),
    generatedAt: new Date().toISOString(),
    period,
    filters,
    kpis: [
      { key: "distance", label: "Total distance", value: `${fmtNum(totalDistance)} km`, tone: "good" },
      { key: "trips", label: "Derived trips", value: String(totalTrips) },
      { key: "driving", label: "Driving time", value: fmtDuration(totalDriving) },
      { key: "idle", label: "Idle time", value: fmtDuration(totalIdle), tone: "warn" },
      {
        key: "avg",
        label: "Fleet average speed",
        value: `${fmtNum(totalDriving + totalIdle > 0 ? totalDistance / ((totalDriving + totalIdle) / 3600) : 0)} km/h`,
      },
    ],
    sections: [
      {
        key: "summary",
        title: "Trip summary by vehicle",
        columns: [
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "trips", label: "Trips", format: "number" },
          { key: "distance_km", label: "Distance (km)", format: "decimal" },
          { key: "driving_time", label: "Driving time" },
          { key: "idle_time", label: "Idle time" },
          { key: "max_speed_kmh", label: "Max speed", format: "decimal" },
          { key: "avg_speed_kmh", label: "Avg speed", format: "decimal" },
          { key: "first_start", label: "First start", format: "date" },
          { key: "last_end", label: "Last end", format: "date" },
        ],
        rows: summaryRows,
      },
      {
        key: "trips",
        title: "Derived trip detail",
        columns: [
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "start_at", label: "Start", format: "date" },
          { key: "end_at", label: "End", format: "date" },
          { key: "start_location", label: "Start location" },
          { key: "end_location", label: "End location" },
          { key: "distance_km", label: "Distance (km)", format: "decimal" },
          { key: "driving_time", label: "Driving time" },
          { key: "idle_time", label: "Idle time" },
          { key: "max_speed_kmh", label: "Max speed", format: "decimal" },
          { key: "avg_speed_kmh", label: "Avg speed", format: "decimal" },
        ],
        rows: tripRows,
      },
      {
        key: "manual",
        title: "Manual trip log",
        columns: [
          { key: "date", label: "Date" },
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "start_location", label: "Start" },
          { key: "destination", label: "Destination" },
          { key: "total_km", label: "Distance (km)", format: "decimal" },
          { key: "time_out", label: "Time out" },
          { key: "time_in", label: "Time in" },
        ],
        rows: manualRows,
      },
    ],
  };
}

function buildDriverBehaviour(vehicles: VehicleRow[], period: ReportPeriod, filters: ReportFilters): ReportResult {
  const vehicleIds = vehicles.map((v) => v.id);
  const vehicleSet = new Set(vehicleIds);
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  const exceptions = db.prepare(`
    SELECT fe.created_at, fe.severity, fe.type, fe.rule_code, fe.description, fe.vehicle_id,
           v.vehicle_number, v.registration_number, gp.lat, gp.lon, gp.speed
    FROM fleet_exceptions fe
    LEFT JOIN vehicles v ON v.id = fe.vehicle_id
    LEFT JOIN gps_positions gp ON gp.id = fe.gps_position_id
    WHERE datetime(fe.created_at) >= datetime(?) AND datetime(fe.created_at) <= datetime(?)
      AND fe.vehicle_id IS NOT NULL
    ORDER BY fe.created_at DESC
  `).all(period.fromUtc, period.toUtc) as any[];

  const driverEvents = db.prepare(`
    SELECT de.recorded_at AS created_at, 'warning' AS severity, de.event_type AS type,
           de.event_type AS rule_code, de.value AS speed, de.lat, de.lon, de.vehicle_id,
           v.vehicle_number, v.registration_number
    FROM driver_events de
    LEFT JOIN vehicles v ON v.id = de.vehicle_id
    WHERE datetime(de.recorded_at) >= datetime(?) AND datetime(de.recorded_at) <= datetime(?)
      AND de.vehicle_id IS NOT NULL
    ORDER BY de.recorded_at DESC
  `).all(period.fromUtc, period.toUtc) as any[];

  const fleetAlerts = db.prepare(`
    SELECT fa.created_at, fa.severity, fa.alert_type AS type, fa.rule_code, fa.message AS description,
           fa.speed, fa.lat, fa.lon, fa.vehicle_id, v.vehicle_number, v.registration_number
    FROM fleet_alerts fa
    LEFT JOIN vehicles v ON v.id = fa.vehicle_id
    WHERE datetime(fa.created_at) >= datetime(?) AND datetime(fa.created_at) <= datetime(?)
      AND fa.vehicle_id IS NOT NULL
    ORDER BY fa.created_at DESC
  `).all(period.fromUtc, period.toUtc) as any[];

  const allowed = new Set([
    "overspeed", "speeding", "eco_driving", "harsh_acceleration", "harsh_accel", "harsh_braking",
    "harsh_cornering", "crash", "excessive_idling", "idling", "towing", "immobilizer", "jamming",
    "sos", "din_trigger",
  ]);

  for (const row of [...exceptions, ...driverEvents, ...fleetAlerts]) {
    if (!vehicleSet.has(row.vehicle_id)) continue;
    const type = String(row.type ?? row.rule_code ?? "").toLowerCase();
    if (!allowed.has(type) && !type.includes("overspeed") && !type.includes("harsh") && !type.includes("idle")) continue;
    const key = `${row.vehicle_id}|${type}|${row.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      created_at: row.created_at,
      vehicle: row.vehicle_number,
      registration: row.registration_number,
      event_type: type.replace(/_/g, " "),
      severity: row.severity,
      rule_code: row.rule_code,
      speed_kmh: row.speed != null ? round(Number(row.speed)) : null,
      lat: row.lat,
      lon: row.lon,
      description: row.description ?? "",
      map_link: row.lat != null && row.lon != null ? `https://www.google.com/maps/search/?api=1&query=${row.lat},${row.lon}` : null,
    });
  }

  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const count = (needle: string) => rows.filter((row) => String(row.event_type).includes(needle)).length;
  const maxSpeed = rows.reduce((max, row) => Math.max(max, Number(row.speed_kmh) || 0), 0);

  return {
    type: "driver-behaviour",
    title: reportTitle("driver-behaviour"),
    generatedAt: new Date().toISOString(),
    period,
    filters,
    kpis: [
      { key: "events", label: "Total events", value: String(rows.length) },
      { key: "overspeed", label: "Overspeeding", value: String(count("overspeed") + count("speeding")), tone: "danger" },
      { key: "accel", label: "Harsh acceleration", value: String(count("accel")), tone: "warn" },
      { key: "brake", label: "Harsh braking", value: String(count("brak")), tone: "warn" },
      { key: "corner", label: "Harsh cornering", value: String(count("corner")), tone: "warn" },
      { key: "max_speed", label: "Max recorded speed", value: `${fmtNum(maxSpeed)} km/h` },
    ],
    sections: [
      {
        key: "events",
        title: "Behaviour event log",
        columns: [
          { key: "created_at", label: "Timestamp", format: "date" },
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "event_type", label: "Event" },
          { key: "severity", label: "Severity" },
          { key: "rule_code", label: "Rule" },
          { key: "speed_kmh", label: "Speed (km/h)", format: "decimal" },
          { key: "lat", label: "Latitude", format: "decimal" },
          { key: "lon", label: "Longitude", format: "decimal" },
          { key: "description", label: "Description" },
          { key: "map_link", label: "Map" },
        ],
        rows,
      },
    ],
  };
}

function buildGeofenceIdle(vehicles: VehicleRow[], period: ReportPeriod, fences: GeofenceRow[], filters: ReportFilters): ReportResult {
  const vehicleSet = new Set(vehicles.map((v) => v.id));
  const eventRows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  const geofenceAlerts = db.prepare(`
    SELECT fa.created_at, fa.alert_type AS type, fa.severity, fa.message AS description,
           fa.lat, fa.lon, fa.vehicle_id, v.vehicle_number, v.registration_number
    FROM fleet_alerts fa
    LEFT JOIN vehicles v ON v.id = fa.vehicle_id
    WHERE datetime(fa.created_at) >= datetime(?) AND datetime(fa.created_at) <= datetime(?)
      AND fa.alert_type IN ('geofence_entry', 'geofence_exit', 'excessive_idling', 'idling')
    ORDER BY fa.created_at DESC
  `).all(period.fromUtc, period.toUtc) as any[];

  const exceptions = db.prepare(`
    SELECT fe.created_at, fe.type, fe.severity, fe.description, fe.rule_code,
           gp.lat, gp.lon, fe.vehicle_id, v.vehicle_number, v.registration_number
    FROM fleet_exceptions fe
    LEFT JOIN vehicles v ON v.id = fe.vehicle_id
    LEFT JOIN gps_positions gp ON gp.id = fe.gps_position_id
    WHERE datetime(fe.created_at) >= datetime(?) AND datetime(fe.created_at) <= datetime(?)
      AND fe.vehicle_id IS NOT NULL
    ORDER BY fe.created_at DESC
  `).all(period.fromUtc, period.toUtc) as any[];

  for (const row of [...geofenceAlerts, ...exceptions]) {
    if (!vehicleSet.has(row.vehicle_id)) continue;
    const type = String(row.type ?? "").toLowerCase();
    if (!type.includes("geofence") && !type.includes("idle")) continue;
    const key = `${row.vehicle_id}|${type}|${row.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eventRows.push({
      created_at: row.created_at,
      vehicle: row.vehicle_number,
      registration: row.registration_number,
      event_type: type.replace(/_/g, " "),
      severity: row.severity,
      description: row.description ?? "",
      lat: row.lat,
      lon: row.lon,
      map_link: row.lat != null && row.lon != null ? `https://www.google.com/maps/search/?api=1&query=${row.lat},${row.lon}` : null,
    });
  }
  eventRows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const dwellRows: Record<string, unknown>[] = [];
  const idleRows: Record<string, unknown>[] = [];
  const idleMinutes = getBusinessRuleNumber("alert_idle_minutes", undefined, 10);

  for (const vehicle of vehicles) {
    const positions = loadPositions(vehicle.id, period);
    if (positions.length === 0) continue;
    for (const fence of fences) {
      if (fence.client_id && vehicle.client_id && fence.client_id !== vehicle.client_id) continue;
      let insideSince: PositionRow | null = null;
      let lastInside: PositionRow | null = null;
      let dwellSeconds = 0;
      let entries = 0;
      let exits = 0;
      for (const position of positions) {
        const inside = haversineKm(position.lat, position.lon, fence.lat, fence.lon) * 1000 <= fence.radius_meters;
        if (inside && !insideSince) {
          insideSince = position;
          entries += 1;
        }
        if (inside) lastInside = position;
        if (!inside && insideSince && lastInside) {
          dwellSeconds += secondsBetween(insideSince.recorded_at, lastInside.recorded_at);
          insideSince = null;
          lastInside = null;
          exits += 1;
        }
      }
      if (insideSince && lastInside) {
        dwellSeconds += secondsBetween(insideSince.recorded_at, lastInside.recorded_at);
        exits += 1;
      }
      if (dwellSeconds > 0) {
        dwellRows.push({
          vehicle: vehicle.vehicle_number,
          registration: vehicle.registration_number,
          geofence: fence.name,
          entries,
          exits,
          dwell_time: fmtDuration(dwellSeconds),
          dwell_minutes: round(dwellSeconds / 60),
        });
      }
    }

    let idleStart: PositionRow | null = null;
    let idleEnd: PositionRow | null = null;
    const flushIdle = () => {
      if (idleStart && idleEnd) {
        const seconds = secondsBetween(idleStart.recorded_at, idleEnd.recorded_at);
        if (seconds >= idleMinutes * 60) {
          idleRows.push({
            vehicle: vehicle.vehicle_number,
            registration: vehicle.registration_number,
            started_at: idleStart.recorded_at,
            ended_at: idleEnd.recorded_at,
            duration: fmtDuration(seconds),
            duration_minutes: round(seconds / 60),
            location: locationLabel(idleStart.lat, idleStart.lon, fences),
          });
        }
      }
      idleStart = null;
      idleEnd = null;
    };
    for (const position of positions) {
      const idle = position.ignition === 1 && (position.speed ?? 0) <= 3;
      if (idle) {
        if (!idleStart) idleStart = position;
        idleEnd = position;
      } else if (idleStart) {
        flushIdle();
      }
    }
    if (idleStart) flushIdle();
  }

  const geofenceEvents = eventRows.filter((row) => String(row.event_type).includes("geofence")).length;
  const idleEvents = eventRows.filter((row) => String(row.event_type).includes("idle")).length;
  const totalIdleMinutes = idleRows.reduce((sum, row) => sum + Number(row.duration_minutes ?? 0), 0);

  return {
    type: "geofence-idle",
    title: reportTitle("geofence-idle"),
    generatedAt: new Date().toISOString(),
    period,
    filters,
    kpis: [
      { key: "geofence_events", label: "Geofence events", value: String(geofenceEvents) },
      { key: "zones", label: "Zones with dwell", value: String(dwellRows.length), tone: "good" },
      { key: "idle_events", label: "Idle exceptions", value: String(idleEvents + idleRows.length), tone: "warn" },
      { key: "idle_time", label: "Derived idle time", value: fmtDuration(totalIdleMinutes * 60), tone: "warn" },
    ],
    sections: [
      {
        key: "events",
        title: "Geofence and idle event log",
        columns: [
          { key: "created_at", label: "Timestamp", format: "date" },
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "event_type", label: "Event" },
          { key: "severity", label: "Severity" },
          { key: "description", label: "Description" },
          { key: "lat", label: "Latitude", format: "decimal" },
          { key: "lon", label: "Longitude", format: "decimal" },
          { key: "map_link", label: "Map" },
        ],
        rows: eventRows,
      },
      {
        key: "dwell",
        title: "Geofence dwell by vehicle",
        columns: [
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "geofence", label: "Geofence" },
          { key: "entries", label: "Entries", format: "number" },
          { key: "exits", label: "Exits", format: "number" },
          { key: "dwell_time", label: "Dwell time" },
          { key: "dwell_minutes", label: "Dwell (min)", format: "decimal" },
        ],
        rows: dwellRows,
      },
      {
        key: "idle",
        title: "Excessive idling sessions",
        columns: [
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "started_at", label: "Started", format: "date" },
          { key: "ended_at", label: "Ended", format: "date" },
          { key: "duration", label: "Duration" },
          { key: "duration_minutes", label: "Minutes", format: "decimal" },
          { key: "location", label: "Location" },
        ],
        rows: idleRows,
      },
    ],
  };
}

function buildFuelUtilization(vehicles: VehicleRow[], period: ReportPeriod, filters: ReportFilters): ReportResult {
  const vehicleSet = new Set(vehicles.map((v) => v.id));
  const fuelLogs = db.prepare(`
    SELECT fl.date, fl.time, fl.station, fl.fuel_type, fl.litres, fl.cost_per_litre,
           fl.total_cost, fl.odometer_reading, fl.l_per_100km, fl.km_per_l,
           v.vehicle_number AS vehicle, v.registration_number AS registration, fl.vehicle_id
    FROM vehicle_fuel_logs fl
    JOIN vehicles v ON v.id = fl.vehicle_id
    WHERE fl.date >= ? AND fl.date <= ?
    ORDER BY fl.date DESC, fl.time DESC
  `).all(period.fromDate, period.toDate) as any[];

  const visibleFuelLogs = fuelLogs.filter((row) => vehicleSet.has(row.vehicle_id));
  const rows: Record<string, unknown>[] = [];
  let totalLitres = 0;
  let totalCost = 0;
  let totalDistance = 0;
  let totalEstimatedFuel = 0;
  let totalUtilization = 0;

  for (const vehicle of vehicles) {
    const positions = loadPositions(vehicle.id, period);
    let distance = 0;
    let fuelUsed = 0;
    let refueled = 0;
    let prevFuel: number | null = null;
    let prevOdo: number | null = null;
    const activeDays = new Set<string>();
    for (let i = 0; i < positions.length; i++) {
      const position = positions[i];
      if (prevOdo != null && position.odometer_km != null && position.odometer_km >= prevOdo) {
        distance += position.odometer_km - prevOdo;
      } else if (prevOdo != null && i > 0) {
        const prev = positions[i - 1];
        distance += haversineKm(prev.lat, prev.lon, position.lat, position.lon);
      }
      if (position.odometer_km != null) prevOdo = position.odometer_km;
      if (position.fuel_liters != null) {
        if (prevFuel != null) {
          const delta = position.fuel_liters - prevFuel;
          if (delta > 0) refueled += delta;
          else fuelUsed += -delta;
        }
        prevFuel = position.fuel_liters;
      }
      if ((position.speed ?? 0) > 3) activeDays.add(position.recorded_at.slice(0, 10));
    }
    const logs = visibleFuelLogs.filter((row) => row.vehicle_id === vehicle.id);
    const loggedLitres = logs.reduce((sum, row) => sum + Number(row.litres ?? 0), 0);
    const loggedCost = logs.reduce((sum, row) => sum + Number(row.total_cost ?? 0), 0);
    const expectedKmL = vehicle.expected_km_per_l ?? 8;
    const estimated = fuelUsed > 0 ? fuelUsed : distance > 0 ? distance / expectedKmL : 0;
    const utilization = Math.min(100, round((activeDays.size / period.days) * 100));
    totalLitres += loggedLitres;
    totalCost += loggedCost;
    totalDistance += distance;
    totalEstimatedFuel += estimated;
    totalUtilization += utilization;
    rows.push({
      vehicle: vehicle.vehicle_number,
      registration: vehicle.registration_number,
      department: vehicle.department,
      fuel_logs: logs.length,
      logged_litres: round(loggedLitres),
      logged_cost: round(loggedCost, 2),
      telemetry_distance_km: round(distance),
      estimated_fuel_litres: round(estimated),
      refuelled_litres: round(refueled),
      l_per_100km: distance > 0 && estimated > 0 ? round((estimated / distance) * 100) : null,
      active_days: activeDays.size,
      utilization_pct: utilization,
      expected_km_per_l: expectedKmL,
    });
  }

  return {
    type: "fuel-utilization",
    title: reportTitle("fuel-utilization"),
    generatedAt: new Date().toISOString(),
    period,
    filters,
    kpis: [
      { key: "litres", label: "Fuel logged", value: `${fmtNum(totalLitres)} L`, tone: "good" },
      { key: "cost", label: "Fuel cost", value: `PGK ${fmtNum(totalCost, 2)}` },
      { key: "distance", label: "Telemetry distance", value: `${fmtNum(totalDistance)} km` },
      { key: "estimated", label: "Estimated consumption", value: `${fmtNum(totalEstimatedFuel)} L` },
      {
        key: "utilization",
        label: "Average utilization",
        value: `${fmtNum(vehicles.length ? totalUtilization / vehicles.length : 0)}%`,
        tone: "warn",
      },
    ],
    sections: [
      {
        key: "summary",
        title: "Fuel and utilisation by vehicle",
        columns: [
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "department", label: "Department" },
          { key: "fuel_logs", label: "Fuel logs", format: "number" },
          { key: "logged_litres", label: "Logged litres", format: "decimal" },
          { key: "logged_cost", label: "Cost (PGK)", format: "currency" },
          { key: "telemetry_distance_km", label: "Distance (km)", format: "decimal" },
          { key: "estimated_fuel_litres", label: "Estimated fuel (L)", format: "decimal" },
          { key: "refuelled_litres", label: "Refuelled (L)", format: "decimal" },
          { key: "l_per_100km", label: "L/100km", format: "decimal" },
          { key: "active_days", label: "Active days", format: "number" },
          { key: "utilization_pct", label: "Utilization", format: "percent" },
        ],
        rows,
      },
      {
        key: "logs",
        title: "Fuel transaction log",
        columns: [
          { key: "date", label: "Date" },
          { key: "time", label: "Time" },
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "station", label: "Station" },
          { key: "fuel_type", label: "Fuel type" },
          { key: "litres", label: "Litres", format: "decimal" },
          { key: "cost_per_litre", label: "Cost/L", format: "currency" },
          { key: "total_cost", label: "Total cost", format: "currency" },
          { key: "odometer_reading", label: "Odometer", format: "decimal" },
          { key: "l_per_100km", label: "L/100km", format: "decimal" },
        ],
        rows: visibleFuelLogs,
      },
    ],
  };
}

function buildFuelCardReconciliation(
  vehicles: VehicleRow[],
  period: ReportPeriod,
  filters: ReportFilters,
  scopes: string[] | null
): ReportResult {
  const vehicleSet = new Set(vehicles.map((vehicle) => vehicle.id));
  const transactions = db
    .prepare(
      `SELECT t.*, fc.provider, fc.status AS card_status,
              COALESCE(fc.assigned_vehicle_id, fc.vehicle_id) AS card_vehicle_id,
              v.vehicle_number, v.registration_number, v.department, v.client_id
       FROM fuel_card_transactions t
       LEFT JOIN fuel_cards fc ON fc.id = t.fuel_card_id
       LEFT JOIN vehicles v ON v.id = t.vehicle_id
       WHERE datetime(t.transaction_at) >= datetime(?) AND datetime(t.transaction_at) <= datetime(?)
       ORDER BY t.transaction_at DESC`
    )
    .all(period.fromUtc, period.toUtc) as any[];

  const visible = transactions.filter((row) => {
    if (!scopes || scopes.length === 0) return true;
    return Boolean(
      (row.vehicle_id && vehicleSet.has(row.vehicle_id)) || (row.card_vehicle_id && vehicleSet.has(row.card_vehicle_id))
    );
  });

  const totalLitres = visible.reduce((sum, row) => sum + Number(row.liters ?? 0), 0);
  const totalAmount = visible.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const flagged = visible.filter((row) => row.status === "flagged");
  const matched = visible.filter((row) => row.status === "matched");
  const cards = new Map<string, any>();

  for (const row of visible) {
    const key = row.card_number;
    const current = cards.get(key) ?? {
      card_number: row.card_number,
      provider: row.provider,
      card_status: row.card_status,
      vehicle: row.vehicle_number,
      registration: row.registration_number,
      department: row.department,
      transactions: 0,
      litres: 0,
      amount: 0,
      flagged: 0,
      last_transaction: row.transaction_at,
    };
    current.transactions += 1;
    current.litres += Number(row.liters ?? 0);
    current.amount += Number(row.amount ?? 0);
    if (row.status === "flagged") current.flagged += 1;
    if (!current.last_transaction || String(row.transaction_at) > String(current.last_transaction)) current.last_transaction = row.transaction_at;
    cards.set(key, current);
  }

  const summaryRows = [...cards.values()]
    .map((row) => ({
      ...row,
      litres: round(row.litres, 2),
      amount: round(row.amount, 2),
    }))
    .sort((a, b) => b.flagged - a.flagged || b.amount - a.amount);

  const transactionRows = visible.map((row) => ({
    transaction_at: row.transaction_at,
    card_number: row.card_number,
    provider: row.provider,
    vehicle: row.vehicle_number,
    registration: row.registration_number,
    station: row.station_name,
    litres: round(Number(row.liters ?? 0), 2),
    amount: row.amount != null ? round(Number(row.amount), 2) : null,
    distance_km: row.distance_km != null ? round(Number(row.distance_km), 2) : null,
    status: row.status,
    flag_reason: row.flag_reason,
  }));

  return {
    type: "fuel-cards",
    title: reportTitle("fuel-cards"),
    generatedAt: new Date().toISOString(),
    period,
    filters,
    kpis: [
      { key: "transactions", label: "Card swipes", value: String(visible.length) },
      { key: "matched", label: "Matched", value: String(matched.length), tone: "good" },
      { key: "flagged", label: "Flagged", value: String(flagged.length), tone: flagged.length > 0 ? "danger" : "good" },
      { key: "litres", label: "Litres", value: `${fmtNum(totalLitres, 2)} L` },
      { key: "amount", label: "Card spend", value: `PGK ${fmtNum(totalAmount, 2)}` },
      {
        key: "flag_rate",
        label: "Flag rate",
        value: `${fmtNum(visible.length ? (flagged.length / visible.length) * 100 : 0)}%`,
        tone: flagged.length > 0 ? "warn" : "good",
      },
    ],
    sections: [
      {
        key: "summary",
        title: "Reconciliation by fuel card",
        columns: [
          { key: "card_number", label: "Card" },
          { key: "provider", label: "Provider" },
          { key: "card_status", label: "Card status" },
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "department", label: "Depot / department" },
          { key: "transactions", label: "Swipes", format: "number" },
          { key: "litres", label: "Litres", format: "decimal" },
          { key: "amount", label: "Amount (PGK)", format: "currency" },
          { key: "flagged", label: "Flagged", format: "number" },
          { key: "last_transaction", label: "Last swipe", format: "date" },
        ],
        rows: summaryRows,
      },
      {
        key: "transactions",
        title: "Fuel card transaction log",
        columns: [
          { key: "transaction_at", label: "Transaction time", format: "date" },
          { key: "card_number", label: "Card" },
          { key: "provider", label: "Provider" },
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "station", label: "Station" },
          { key: "litres", label: "Litres", format: "decimal" },
          { key: "amount", label: "Amount (PGK)", format: "currency" },
          { key: "distance_km", label: "GPS distance (km)", format: "decimal" },
          { key: "status", label: "Status" },
          { key: "flag_reason", label: "Flag reason" },
        ],
        rows: transactionRows,
      },
    ],
  };
}

function buildDeviceHealth(vehicles: VehicleRow[], period: ReportPeriod, filters: ReportFilters, scopes: string[] | null): ReportResult {
  const where = vehicleWhere(filters, scopes);
  const devices = db.prepare(`
    SELECT g.id, g.device_identifier AS imei, g.device_model, g.status, g.last_seen_at,
           v.id AS vehicle_id, v.vehicle_number, v.registration_number, v.client_id
    FROM gps_devices g
    JOIN vehicles v ON v.id = g.vehicle_id
    LEFT JOIN clients c ON c.id = v.client_id
    WHERE ${where.sql}
    ORDER BY v.vehicle_number ASC
  `).all(...where.params) as any[];

  const lowVoltage = getBusinessRuleNumber("alert_low_voltage_v", undefined, 11.5);
  const healthRows: Record<string, unknown>[] = [];
  let onlineCount = 0;
  let totalUptime = 0;
  let voltageDrops = 0;

  for (const device of devices) {
    const positions = loadPositions(device.vehicle_id, period);
    const days = new Set(positions.map((p) => p.recorded_at.slice(0, 10)));
    const minExt = positions.reduce<number | null>((min, p) => (p.ext_voltage_v == null ? min : min == null ? p.ext_voltage_v : Math.min(min, p.ext_voltage_v)), null);
    const minInt = positions.reduce<number | null>((min, p) => (p.int_battery_v == null ? min : min == null ? p.int_battery_v : Math.min(min, p.int_battery_v)), null);
    const drops = positions.filter((p) => p.ext_voltage_v != null && p.ext_voltage_v > 0 && p.ext_voltage_v < lowVoltage).length;
    const uptime = Math.min(100, round((days.size / period.days) * 100));
    const online = device.last_seen_at ? Date.now() - new Date(`${String(device.last_seen_at).replace(" ", "T")}Z`).getTime() <= 15 * 60 * 1000 : false;
    if (online) onlineCount += 1;
    totalUptime += uptime;
    voltageDrops += drops;
    healthRows.push({
      vehicle: device.vehicle_number,
      registration: device.registration_number,
      imei: device.imei,
      model: device.device_model,
      status: device.status,
      online: online ? "Online" : "Offline",
      last_seen_at: device.last_seen_at,
      fixes: positions.length,
      active_days: days.size,
      uptime_pct: uptime,
      min_external_v: minExt != null ? round(minExt, 2) : null,
      min_internal_v: minInt != null ? round(minInt, 2) : null,
      voltage_drops: drops,
    });
  }

  const commandWhere = vehicleWhere(filters, scopes);
  const commands = db.prepare(`
    SELECT dc.created_at, dc.imei, dc.command_type, dc.raw_command, dc.status, dc.response_text,
           dc.sent_at, dc.acked_at, v.vehicle_number AS vehicle, v.registration_number AS registration
    FROM device_commands dc
    LEFT JOIN vehicles v ON v.id = dc.vehicle_id
    LEFT JOIN clients c ON c.id = v.client_id
    WHERE ${commandWhere.sql} AND datetime(dc.created_at) >= datetime(?) AND datetime(dc.created_at) <= datetime(?)
      ${filters.imei ? "AND dc.imei = ?" : ""}
    ORDER BY dc.created_at DESC
    LIMIT 2000
  `).all(...commandWhere.params, period.fromUtc, period.toUtc, ...(filters.imei ? [filters.imei] : [])) as any[];

  const configWhere = vehicleWhere(filters, scopes);
  const configChanges = db.prepare(`
    SELECT dcs.updated_at, dcs.imei, dcs.param_id, dcs.feature_key, dcs.desired_value, dcs.applied_value,
           dcs.status, dcs.response_text, v.vehicle_number AS vehicle, v.registration_number AS registration
    FROM device_config_state dcs
    LEFT JOIN vehicles v ON v.id = dcs.vehicle_id
    LEFT JOIN clients c ON c.id = v.client_id
    WHERE ${configWhere.sql} AND datetime(dcs.updated_at) >= datetime(?) AND datetime(dcs.updated_at) <= datetime(?)
      ${filters.imei ? "AND dcs.imei = ?" : ""}
    ORDER BY dcs.updated_at DESC
    LIMIT 2000
  `).all(...configWhere.params, period.fromUtc, period.toUtc, ...(filters.imei ? [filters.imei] : [])) as any[];

  return {
    type: "device-health",
    title: reportTitle("device-health"),
    generatedAt: new Date().toISOString(),
    period,
    filters,
    kpis: [
      { key: "devices", label: "Devices", value: String(devices.length) },
      { key: "online", label: "Online now", value: String(onlineCount), tone: onlineCount === devices.length ? "good" : "warn" },
      { key: "uptime", label: "Average uptime", value: `${fmtNum(devices.length ? totalUptime / devices.length : 0)}%` },
      { key: "drops", label: "Low-voltage fixes", value: String(voltageDrops), tone: voltageDrops > 0 ? "warn" : "good" },
      { key: "config", label: "Config changes", value: String(configChanges.length) },
    ],
    sections: [
      {
        key: "health",
        title: "Device health",
        columns: [
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "imei", label: "IMEI" },
          { key: "model", label: "Model" },
          { key: "status", label: "Status" },
          { key: "online", label: "Online" },
          { key: "last_seen_at", label: "Last seen", format: "date" },
          { key: "fixes", label: "Fixes", format: "number" },
          { key: "active_days", label: "Active days", format: "number" },
          { key: "uptime_pct", label: "Uptime", format: "percent" },
          { key: "min_external_v", label: "Min ext. V", format: "decimal" },
          { key: "min_internal_v", label: "Min int. V", format: "decimal" },
          { key: "voltage_drops", label: "Low-V fixes", format: "number" },
        ],
        rows: healthRows,
      },
      {
        key: "commands",
        title: "Codec 12 command audit",
        columns: [
          { key: "created_at", label: "Created", format: "date" },
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "imei", label: "IMEI" },
          { key: "command_type", label: "Type" },
          { key: "raw_command", label: "Command" },
          { key: "status", label: "Status" },
          { key: "sent_at", label: "Sent", format: "date" },
          { key: "acked_at", label: "Acked", format: "date" },
          { key: "response_text", label: "Response" },
        ],
        rows: commands,
      },
      {
        key: "config",
        title: "Remote configuration changes",
        columns: [
          { key: "updated_at", label: "Updated", format: "date" },
          { key: "vehicle", label: "Vehicle" },
          { key: "registration", label: "Registration" },
          { key: "imei", label: "IMEI" },
          { key: "param_id", label: "Param ID", format: "number" },
          { key: "feature_key", label: "Feature" },
          { key: "desired_value", label: "Desired" },
          { key: "applied_value", label: "Applied" },
          { key: "status", label: "Status" },
          { key: "response_text", label: "Response" },
        ],
        rows: configChanges,
      },
    ],
  };
}

export function buildReport(type: ReportType, filters: ReportFilters, scopes: string[] | null): ReportResult {
  const period = normalizeReportPeriod(filters.from, filters.to);
  const vehicles = loadVehicles(filters, scopes);
  const fences = loadGeofences(scopes);
  switch (type) {
    case "trip-mileage":
      return buildTripMileage(vehicles, period, fences, filters, scopes);
    case "driver-behaviour":
      return buildDriverBehaviour(vehicles, period, filters);
    case "geofence-idle":
      return buildGeofenceIdle(vehicles, period, fences, filters);
    case "fuel-utilization":
      return buildFuelUtilization(vehicles, period, filters);
    case "fuel-cards":
      return buildFuelCardReconciliation(vehicles, period, filters, scopes);
    case "device-health":
      return buildDeviceHealth(vehicles, period, filters, scopes);
    default:
      throw new Error(`Unknown report type: ${type}`);
  }
}

/* ------------------------------------------------------------------ *
 * CSV / email rendering
 * ------------------------------------------------------------------ */

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportToCsv(report: ReportResult): string {
  const lines: string[] = [];
  lines.push(`Report,${csvEscape(report.title)}`);
  lines.push(`Period,${csvEscape(`${report.period.fromPgt} to ${report.period.toPgt}`)}`);
  lines.push(`Generated,${csvEscape(report.generatedAt)}`);
  lines.push("");
  for (const section of report.sections) {
    lines.push(`# ${section.title}`);
    lines.push(section.columns.map((column) => csvEscape(column.label)).join(","));
    for (const row of section.rows) {
      lines.push(section.columns.map((column) => csvEscape(row[column.key])).join(","));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function reportToText(report: ReportResult): string {
  const lines = [
    `Fleet Management System — ${report.title}`,
    `Period: ${report.period.fromPgt} to ${report.period.toPgt}`,
    `Generated: ${formatPgt(report.generatedAt)}`,
    "",
    "Summary",
    ...report.kpis.map((kpi) => `- ${kpi.label}: ${kpi.value}`),
    "",
  ];
  for (const section of report.sections) {
    lines.push(`${section.title} (${section.rows.length} rows)`);
    for (const row of section.rows.slice(0, 20)) {
      lines.push(
        section.columns
          .map((column) => `${column.label}: ${row[column.key] ?? "—"}`)
          .join(" | ")
      );
    }
    if (section.rows.length > 20) lines.push(`… ${section.rows.length - 20} more rows in the CSV attachment`);
    lines.push("");
  }
  return lines.join("\n");
}

export function reportToHtml(report: ReportResult): string {
  const kpis = report.kpis
    .map(
      (kpi) => `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;min-width:150px;flex:1">
        <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#64748b">${escapeHtml(kpi.label)}</div>
        <div style="font-size:20px;font-weight:700;color:#0f172a;margin-top:4px">${escapeHtml(kpi.value)}</div>
      </div>`
    )
    .join("");

  const sections = report.sections
    .map((section) => {
      const rows = section.rows
        .slice(0, 100)
        .map(
          (row) =>
            `<tr>${section.columns
              .map(
                (column) =>
                  `<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#334155">${escapeHtml(
                    row[column.key]
                  )}</td>`
              )
              .join("")}</tr>`
        )
        .join("");
      return `<h3 style="font-size:14px;color:#0f172a;margin:22px 0 8px">${escapeHtml(section.title)} (${section.rows.length})</h3>
        <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:8px">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:#f8fafc">${section.columns
              .map(
                (column) =>
                  `<th style="padding:7px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;border-bottom:1px solid #e2e8f0">${escapeHtml(
                    column.label
                  )}</th>`
              )
              .join("")}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${section.columns.length}" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px">No rows</td></tr>`}</tbody>
          </table>
        </div>
        ${section.rows.length > 100 ? `<p style="font-size:11px;color:#94a3b8">Showing first 100 rows; full data is in the CSV attachment.</p>` : ""}`;
    })
    .join("");

  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:1000px;margin:24px auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#0b1220;padding:20px 24px;color:#fff">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#f5a623">Fleet Management System</div>
        <div style="font-size:22px;font-weight:700;margin-top:4px">${escapeHtml(report.title)}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">${escapeHtml(report.period.fromPgt)} to ${escapeHtml(report.period.toPgt)}</div>
      </div>
      <div style="padding:20px 24px">
        <div style="display:flex;flex-wrap:wrap;gap:10px">${kpis}</div>
        ${sections}
        <p style="font-size:11px;color:#94a3b8;margin-top:22px">Generated ${escapeHtml(formatPgt(report.generatedAt))}. CSV attachment contains the full report.</p>
      </div>
    </div>
  </body></html>`;
}
