import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireIngestToken } from "../middleware/auth";
import { resolveClientScopes } from "../utils/scope";
import { writeAudit } from "../utils/audit";

const router = Router();

/* ------------------------------------------------------------------ *
 * Teltonika FMB125 AVL IO element interpretation
 * ------------------------------------------------------------------ */

/** Default fuel level change (litres) required to count as a refuel/drain. */
export const FUEL_DELTA_THRESHOLD_L = 5;

/** Reads a non-negative number from an env var, falling back when unset/invalid. */
function numericEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Configurable refuel / drain thresholds (litres), read from the environment at
 * call time so a deployment can tune them without a rebuild:
 *   FUEL_REFUEL_MIN_L (default 5), FUEL_DRAIN_MIN_L (default 5).
 * Deltas smaller than the threshold are treated as sensor jitter and ignored.
 */
export function fuelThresholds(): { refuel: number; drain: number } {
  return {
    refuel: numericEnv("FUEL_REFUEL_MIN_L", FUEL_DELTA_THRESHOLD_L),
    drain: numericEnv("FUEL_DRAIN_MIN_L", FUEL_DELTA_THRESHOLD_L),
  };
}

export interface IoAlertRule {
  ioId: number;
  /** Telemetry alert type stored on the alert row. */
  type: string;
  ruleCode: string;
  severity: "critical" | "warning" | "info";
  category: string;
  label: string;
}

/**
 * Event-style IO elements that map directly to a fleet exception when their
 * value is truthy. IO ids per the Teltonika FMB125 AVL parameter list.
 */
export const IO_ALERT_RULES: IoAlertRule[] = [
  { ioId: 255, type: "overspeed", ruleCode: "RULE_OVERSPEED", severity: "warning", category: "telemetry", label: "Overspeed" },
  { ioId: 251, type: "idling", ruleCode: "RULE_EXCESSIVE_IDLING", severity: "warning", category: "telemetry", label: "Excessive idling" },
  { ioId: 252, type: "power_unplug", ruleCode: "RULE_DEVICE_UNPLUG", severity: "critical", category: "security", label: "Device unplug / tamper" },
  { ioId: 246, type: "towing", ruleCode: "RULE_TOWING_DETECTED", severity: "critical", category: "security", label: "Towing detected" },
  { ioId: 247, type: "crash", ruleCode: "RULE_CRASH_DETECTED", severity: "critical", category: "driver", label: "Crash detected" },
  { ioId: 175, type: "geofence_entry", ruleCode: "RULE_GEOFENCE_IO", severity: "warning", category: "geofence", label: "Geofence event" },
  { ioId: 179, type: "immobilizer", ruleCode: "RULE_IMMOBILIZER", severity: "warning", category: "security", label: "Immobilizer / DOUT" },
  { ioId: 253, type: "eco_driving", ruleCode: "RULE_ECO_DRIVING", severity: "info", category: "driver", label: "Eco driving (harsh acceleration)" },
  { ioId: 254, type: "eco_driving", ruleCode: "RULE_ECO_DRIVING", severity: "info", category: "driver", label: "Eco driving (harsh braking)" },
];

/** Geofence zone IO ids in the 155–174 block are reported as zone events. */
const GEOFENCE_ZONE_IO_MIN = 155;
const GEOFENCE_ZONE_IO_MAX = 174;

/** Well-known scalar IO elements stored on the position / live-state. */
const IO_ODOMETER = [16];
const IO_IGNITION = [239];
const IO_GSM = [21];
/** IO 12/13 are the Teltonika fuel counter elements (raw, stored in io_json). */
const IO_FUEL_COUNTER = [12, 13];
/** IO 66 external (main) power voltage, reported in millivolts. */
const IO_EXTERNAL_VOLTAGE = 66;
/** Below this external voltage (mV) the device is running on internal battery. */
const EXTERNAL_VOLTAGE_MIN_MV = 1000;

export interface InterpretedAlert {
  type: string;
  ruleCode: string;
  severity: "critical" | "warning" | "info";
  category: string;
  description: string;
  ioId?: number;
  value?: number;
}

function ioValue(io: Record<string, number>, ids: number[]): number | undefined {
  for (const id of ids) {
    const v = io[String(id)];
    if (v !== undefined && v !== null) return Number(v);
  }
  return undefined;
}

/**
 * Maps truthy FMB125 IO elements to fleet-exception alert specs. Scalar
 * telemetry IO (fuel counter 12/13, odometer 16, GSM 21) is captured on the
 * position row instead of producing an alert.
 */
export function interpretIoAlerts(io: Record<string, number> = {}): InterpretedAlert[] {
  const alerts: InterpretedAlert[] = [];

  for (const rule of IO_ALERT_RULES) {
    const value = io[String(rule.ioId)];
    if (value === undefined || value === null || !Number(value)) continue;
    alerts.push({
      type: rule.type,
      ruleCode: rule.ruleCode,
      severity: rule.severity,
      category: rule.category,
      description: `${rule.label} (IO ${rule.ioId}=${value}).`,
      ioId: rule.ioId,
      value: Number(value),
    });
  }

  // Main-power cut: IO 66 external voltage drops below the internal-battery
  // threshold, i.e. the tracker has lost vehicle power (a power_unplug-style
  // event). Only fires when the element is actually present in the payload.
  const extRaw = io[String(IO_EXTERNAL_VOLTAGE)];
  if (extRaw !== undefined && extRaw !== null && Number(extRaw) < EXTERNAL_VOLTAGE_MIN_MV) {
    alerts.push({
      type: "power_unplug",
      ruleCode: "RULE_MAIN_POWER_CUT",
      severity: "critical",
      category: "security",
      description: `External power lost (IO ${IO_EXTERNAL_VOLTAGE}=${extRaw} mV).`,
      ioId: IO_EXTERNAL_VOLTAGE,
      value: Number(extRaw),
    });
  }

  for (let id = GEOFENCE_ZONE_IO_MIN; id <= GEOFENCE_ZONE_IO_MAX; id++) {
    const value = io[String(id)];
    if (value === undefined || value === null || !Number(value)) continue;
    alerts.push({
      type: "geofence_entry",
      ruleCode: "RULE_GEOFENCE_ZONE",
      severity: "warning",
      category: "geofence",
      description: `Geofence zone ${id} event (IO ${id}=${value}).`,
      ioId: id,
      value: Number(value),
    });
  }

  return alerts;
}

/**
 * Classifies a change in absolute fuel level as a refuel, a drain, or neither.
 * Deltas smaller than the configured thresholds (`fuelThresholds()`) are treated
 * as sensor jitter (rough roads) and ignored.
 */
export function detectFuelDelta(previous: number | null, current: number | null): "refuel" | "drain" | null {
  if (previous === null || current === null) return null;
  const delta = current - previous;
  const { refuel, drain } = fuelThresholds();
  if (delta >= refuel) return "refuel";
  if (delta <= -drain) return "drain";
  return null;
}

/**
 * Offline window in minutes, from `DEVICE_OFFLINE_MINUTES` (default 15). A
 * device whose `last_seen_at` is older than this is considered offline.
 */
export function offlineWindowMinutes(): number {
  const raw = Number(process.env.DEVICE_OFFLINE_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
}

/**
 * True when the device was last seen within the offline window. Handles both
 * the SQLite `YYYY-MM-DD HH:MM:SS` (UTC) form and ISO-8601 timestamps.
 */
export function isDeviceOnline(lastSeenAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const iso = lastSeenAt.includes("T") ? lastSeenAt : lastSeenAt.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return now - t <= offlineWindowMinutes() * 60 * 1000;
}

/** Configured fuel-counter IO rows (feature_key 'fuel_counter') with their scale. */
export function loadFuelCounterRows(): { io_id: number; scale_factor: number }[] {
  return db
    .prepare("SELECT io_id, scale_factor FROM io_feature_map WHERE feature_key = 'fuel_counter' AND enabled = 1 ORDER BY io_id ASC")
    .all() as { io_id: number; scale_factor: number }[];
}

/**
 * Derives fuel_liters from a raw fuel-counter IO element when the relay does
 * not send fuel_liters directly. The raw counter is multiplied by the row's
 * configurable scale_factor (IO 12/13 report millilitres → 0.001 = litres), so
 * fuel_liters always holds litres and never the raw counter.
 */
export function fuelLitersFromIo(
  io: Record<string, number>,
  rows: { io_id: number; scale_factor: number }[] = loadFuelCounterRows()
): number | null {
  for (const row of rows) {
    const raw = io[String(row.io_id)];
    if (raw === undefined || raw === null) continue;
    const scale = Number(row.scale_factor) || 1;
    return Number((Number(raw) * scale).toFixed(3));
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Ingest schema
 * ------------------------------------------------------------------ */

export const ingestSchema = z.object({
  imei: z.string().min(1),
  timestamp: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "timestamp must be a valid ISO-8601 date-time",
  }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  sats: z.number().int().nullable().optional(),
  speed_kmh: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  odometer: z.number().nullable().optional(),
  ignition: z.union([z.boolean(), z.number(), z.null()]).optional(),
  fuel_liters: z.number().nullable().optional(),
  io: z.record(z.number()).optional(),
});

export type IngestInput = z.infer<typeof ingestSchema>;

/** Normalizes an ISO-8601 timestamp into the SQLite `YYYY-MM-DD HH:MM:SS` form. */
export function normalizeTimestamp(input: string): string {
  return new Date(input).toISOString().replace("T", " ").substring(0, 19);
}

function activeDriverId(vehicleId: string): string | null {
  const allocation = db
    .prepare("SELECT driver_id FROM vehicle_allocations WHERE vehicle_id = ? AND authorisation_status = 'active' LIMIT 1")
    .get(vehicleId) as { driver_id: string } | undefined;
  return allocation?.driver_id ?? null;
}

function ignitionValue(input: IngestInput): number {
  const ioIgnition = input.io ? ioValue(input.io, IO_IGNITION) : undefined;
  if (ioIgnition !== undefined) return ioIgnition ? 1 : 0;
  if (typeof input.ignition === "boolean") return input.ignition ? 1 : 0;
  if (typeof input.ignition === "number") return input.ignition ? 1 : 0;
  return 0;
}

/* ------------------------------------------------------------------ *
 * POST /api/telemetry/ingest
 * ------------------------------------------------------------------ */

/**
 * Ingest a single normalized FMB125 telemetry record. Idempotent on
 * (imei, recorded_at): a duplicate insert is ignored and reported.
 */
router.post("/ingest", requireIngestToken, (req, res, next) => {
  try {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid telemetry payload", details: parsed.error.flatten() });
    }
    const input = parsed.data;

    const device = db
      .prepare("SELECT id, vehicle_id, client_id FROM gps_devices WHERE device_identifier = ?")
      .get(input.imei) as { id: string; vehicle_id: string | null; client_id: string | null } | undefined;

    if (!device) {
      return res.status(404).json({ error: "Unknown device", details: `No gps_device registered for IMEI '${input.imei}'` });
    }
    if (!device.vehicle_id) {
      return res.status(400).json({ error: "Device not bound to a vehicle", details: `IMEI '${input.imei}' is registered but has no vehicle_id` });
    }

    const vehicleId = device.vehicle_id;
    const recordedAt = normalizeTimestamp(input.timestamp);
    const io = input.io ?? {};
    const odometer = input.odometer ?? ioValue(io, IO_ODOMETER) ?? 0;
    const gsmSignal = ioValue(io, IO_GSM) ?? null;
    // Fuel: prefer an explicit fuel_liters; otherwise derive litres from the
    // raw IO 12/13 fuel counter via its configured scale_factor. Never store
    // the raw counter value in fuel_liters.
    const fuelLiters = input.fuel_liters ?? fuelLitersFromIo(io);
    // IO 12/13 are the Teltonika fuel counters; keep the raw value alongside
    // io_json for diagnostics while refuel/drain is derived from fuel_liters.
    const fuelCounter = ioValue(io, IO_FUEL_COUNTER) ?? null;
    const posId = uuid();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO gps_positions (
        id, vehicle_id, lat, lon, speed, heading, ignition, odometer, source, recorded_at,
        gsm_signal, fuel_liters, sats, imei, io_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'teltonika', ?, ?, ?, ?, ?, ?)
    `).run(
      posId,
      vehicleId,
      input.lat,
      input.lon,
      input.speed_kmh ?? 0,
      input.heading ?? 0,
      ignitionValue(input),
      odometer,
      recordedAt,
      gsmSignal,
      fuelLiters,
      input.sats ?? null,
      input.imei,
      Object.keys(io).length ? JSON.stringify(io) : null
    );

    if (insert.changes === 0) {
      return res.status(200).json({ duplicate: true, message: "Duplicate telemetry record ignored", imei: input.imei, recordedAt });
    }

    // Canonical rich telemetry record, idempotent on (imei, recorded_at).
    db.prepare(`
      INSERT OR IGNORE INTO telemetry_records (
        id, imei, vehicle_id, recorded_at, lat, lon, sats, speed_kmh, ignition, fuel_liters, io_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      input.imei,
      vehicleId,
      recordedAt,
      input.lat,
      input.lon,
      input.sats ?? null,
      input.speed_kmh ?? null,
      ignitionValue(input),
      fuelLiters,
      Object.keys(io).length ? JSON.stringify(io) : null
    );

    // Update vehicle live-state cache; last_seen_at stamps the successful
    // ingest so the offline watchdog can tell fresh data from a silent device.
    db.prepare(`
      UPDATE vehicles
      SET current_latitude = ?, current_longitude = ?, last_gps_fix_at = ?,
          current_odometer = MAX(current_odometer, ?), updated_at = datetime('now'),
          last_seen_at = datetime('now')
      WHERE id = ?
    `).run(input.lat, input.lon, recordedAt, odometer, vehicleId);

    if (fuelLiters !== null) {
      const vehicle = db.prepare("SELECT tank_capacity_litres FROM vehicles WHERE id = ?").get(vehicleId) as { tank_capacity_litres: number | null } | undefined;
      const capacity = vehicle?.tank_capacity_litres ?? null;
      if (capacity && capacity > 0) {
        const pct = Math.max(0, Math.min(100, (fuelLiters / capacity) * 100));
        db.prepare("UPDATE vehicles SET current_fuel_level_pct = ? WHERE id = ?").run(pct, vehicleId);
      }
    }

    const driverId = activeDriverId(vehicleId);
    const alerts = interpretIoAlerts(io);

    // Detect refuel / drain from the change in absolute fuel level since the last fix
    let fuelDeltaAlert: InterpretedAlert | null = null;
    if (fuelLiters !== null) {
      const prev = db.prepare(`
        SELECT fuel_liters FROM gps_positions
        WHERE vehicle_id = ? AND fuel_liters IS NOT NULL AND recorded_at < ?
        ORDER BY recorded_at DESC LIMIT 1
      `).get(vehicleId, recordedAt) as { fuel_liters: number } | undefined;
      const kind = detectFuelDelta(prev?.fuel_liters ?? null, fuelLiters);
      if (kind === "refuel") {
        fuelDeltaAlert = { type: "refuel", ruleCode: "RULE_REFUEL_DETECTED", severity: "info", category: "fuel", description: `Refuel detected: fuel level rose from ${prev?.fuel_liters}L to ${fuelLiters}L.` };
      } else if (kind === "drain") {
        fuelDeltaAlert = { type: "fuel_drain", ruleCode: "RULE_FUEL_DRAIN", severity: "warning", category: "fuel", description: `Possible fuel drain: fuel level fell from ${prev?.fuel_liters}L to ${fuelLiters}L.` };
      }
    }
    if (fuelDeltaAlert) alerts.push(fuelDeltaAlert);

    // Persist alert rows (fast, one prepared insert per alert)
    const insertException = db.prepare(`
      INSERT INTO fleet_exceptions (
        id, severity, category, type, source, rule_code, vehicle_id, driver_id, gps_position_id, description, status, created_at
      ) VALUES (?, ?, ?, ?, 'telemetry', ?, ?, ?, ?, ?, 'open', ?)
    `);
    for (const alert of alerts) {
      insertException.run(uuid(), alert.severity, alert.category, alert.type, alert.ruleCode, vehicleId, driverId, posId, alert.description, recordedAt);
    }

    // Safety-relevant IO events also feed driver-intelligence scoring
    const driverEventMap: Record<number, { type: string; magnitude: number }> = {
      247: { type: "crash", magnitude: input.speed_kmh ?? 0 },
      255: { type: "speeding", magnitude: ioValue(io, [255]) ?? input.speed_kmh ?? 0 },
    };
    const insertDriverEvent = db.prepare(`
      INSERT INTO driver_events (id, event_type, vehicle_id, driver_id, recorded_at, value, lat, lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const alert of alerts) {
      const mapped = alert.ioId !== undefined ? driverEventMap[alert.ioId] : undefined;
      if (mapped) {
        insertDriverEvent.run(uuid(), mapped.type, vehicleId, driverId, recordedAt, mapped.magnitude, input.lat, input.lon);
      }
    }

    const position = db.prepare("SELECT * FROM gps_positions WHERE id = ?").get(posId);
    return res.status(201).json({ data: position, alerts: alerts.length, fuelCounter, message: "Telemetry ingested" });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * Read endpoints (JWT-authenticated, client-scoped)
 * ------------------------------------------------------------------ */

router.use(requireAuth);

/** Builds an `AND <alias>.client_id IN (...)` clause fragment when scoped. */
function clientClause(scopes: string[] | null, alias = "v"): { sql: string; params: any[] } {
  if (!scopes || scopes.length === 0) return { sql: "", params: [] };
  return { sql: ` AND ${alias}.client_id IN (${scopes.map(() => "?").join(", ")})`, params: scopes };
}

export interface IoFeatureRow {
  io_id: number;
  feature_key: string;
  label: string;
  value_type: string;
  enabled: number;
  scale_factor: number;
}

/** Loads the enabled IO-ID -> feature mapping (configurable via the settings API). */
export function loadIoFeatureMap(): IoFeatureRow[] {
  return db
    .prepare("SELECT io_id, feature_key, label, value_type, enabled, scale_factor FROM io_feature_map WHERE enabled = 1 ORDER BY io_id ASC")
    .all() as IoFeatureRow[];
}

/** Decodes a raw Teltonika IO payload into the configured feature list. */
export function decodeIoFeatures(io: Record<string, number>, map: IoFeatureRow[] = loadIoFeatureMap()) {
  return map.map((f) => {
    const raw = io[String(f.io_id)] ?? null;
    const scale = Number(f.scale_factor) || 1;
    return {
      io_id: f.io_id,
      feature_key: f.feature_key,
      label: f.label,
      value_type: f.value_type,
      scale_factor: scale,
      value: raw,
      // Scaled (engineering-unit) value, e.g. fuel counter ml -> litres.
      scaled_value: raw === null ? null : Number((Number(raw) * scale).toFixed(3)),
    };
  });
}

/**
 * GET /api/telemetry/latest
 * Latest position, ignition, speed, satellites and fuel for each vehicle the
 * caller may see (all vehicles for fleet roles, own client otherwise).
 */
router.get("/latest", (req, res, next) => {
  try {
    const scope = resolveClientScopes(req.user);
    const { sql: clause, params } = clientClause(scope);
    const rows = db.prepare(`
      SELECT
        v.id AS vehicle_id,
        v.vehicle_number,
        v.registration_number,
        v.make,
        v.model,
        v.department,
        v.client_id,
        c.name AS client_name,
        v.current_latitude AS lat,
        v.current_longitude AS lon,
        v.current_fuel_level_pct AS fuel_level_pct,
        v.last_gps_fix_at AS recorded_at,
        v.last_seen_at,
        vsv.computed_status,
        gp.speed,
        gp.heading,
        gp.ignition,
        gp.sats,
        gp.fuel_liters,
        gp.imei,
        gp.gsm_signal,
        gp.source,
        gp.io_json
      FROM vehicles v
      LEFT JOIN clients c ON c.id = v.client_id
      LEFT JOIN vehicle_status_view vsv ON v.id = vsv.vehicle_id
      LEFT JOIN (
        SELECT p1.* FROM gps_positions p1
        INNER JOIN (
          SELECT vehicle_id, MAX(recorded_at) AS max_rec FROM gps_positions GROUP BY vehicle_id
        ) p2 ON p1.vehicle_id = p2.vehicle_id AND p1.recorded_at = p2.max_rec
      ) gp ON v.id = gp.vehicle_id
      WHERE v.status != 'disposed'${clause}
      ORDER BY v.vehicle_number ASC
    `).all(...params) as any[];

    // Offline watchdog: flag each vehicle from its last successful ingest.
    const data = rows.map((r) => ({ ...r, online: isDeviceOnline(r.last_seen_at) }));
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/telemetry/features/:imei
 * Decodes the device's latest raw IO payload through the configurable
 * `io_feature_map` and returns the feature list plus recent telemetry events.
 */
router.get("/features/:imei", (req, res, next) => {
  try {
    const scope = resolveClientScopes(req.user);
    const imei = req.params.imei;

    const device = db
      .prepare("SELECT id, vehicle_id, client_id FROM gps_devices WHERE device_identifier = ?")
      .get(imei) as { id: string; vehicle_id: string | null; client_id: string | null } | undefined;
    if (!device?.vehicle_id) {
      return res.status(404).json({ error: "Unknown or unbound device", details: `No vehicle bound to IMEI '${imei}'` });
    }
    if (scope && (!device.client_id || !scope.includes(device.client_id))) {
      return res.status(403).json({ error: "Forbidden: device is outside your client scope" });
    }

    const vehicle = db
      .prepare("SELECT vehicle_number, registration_number, last_seen_at FROM vehicles WHERE id = ?")
      .get(device.vehicle_id) as { vehicle_number: string; registration_number: string; last_seen_at: string | null } | undefined;

    const latest = db
      .prepare(`
        SELECT recorded_at, lat, lon, sats, speed_kmh, ignition, fuel_liters, io_json
        FROM telemetry_records WHERE imei = ? ORDER BY recorded_at DESC LIMIT 1
      `)
      .get(imei) as any;

    let io: Record<string, number> = {};
    if (latest?.io_json) {
      try { io = JSON.parse(latest.io_json); } catch {}
    }

    const events = db
      .prepare(`
        SELECT id, created_at, severity, category, type, rule_code, description, status
        FROM fleet_exceptions
        WHERE vehicle_id = ? AND source = 'telemetry'
        ORDER BY created_at DESC LIMIT 20
      `)
      .all(device.vehicle_id);

    res.json({
      data: {
        imei,
        vehicle_id: device.vehicle_id,
        client_id: device.client_id,
        vehicle_number: vehicle?.vehicle_number ?? null,
        registration_number: vehicle?.registration_number ?? null,
        last_seen_at: vehicle?.last_seen_at ?? null,
        online: isDeviceOnline(vehicle?.last_seen_at),
        live: latest
          ? {
              recorded_at: latest.recorded_at,
              lat: latest.lat,
              lon: latest.lon,
              sats: latest.sats,
              speed_kmh: latest.speed_kmh,
              ignition: latest.ignition,
              fuel_liters: latest.fuel_liters,
            }
          : null,
        features: decodeIoFeatures(io),
        events,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/telemetry/summary?from&to
 * Fuel consumption, distance, refuel/drain events and alert log over a range.
 */
router.get("/summary", (req, res, next) => {
  try {
    const scope = resolveClientScopes(req.user);
    const { sql: clause, params } = clientClause(scope);
    const from = (req.query.from as string) || "1970-01-01 00:00:00";
    const to = (req.query.to as string) || "2999-12-31 23:59:59";

    const vehicles = db.prepare(`
      SELECT v.id AS vehicle_id, v.vehicle_number, v.registration_number, v.client_id, c.name AS client_name
      FROM vehicles v LEFT JOIN clients c ON c.id = v.client_id
      WHERE v.status != 'disposed'${clause}
      ORDER BY v.vehicle_number ASC
    `).all(...params) as any[];

    const positionsStmt = db.prepare(`
      SELECT recorded_at, odometer, fuel_liters
      FROM gps_positions
      WHERE vehicle_id = ? AND datetime(recorded_at) >= datetime(?) AND datetime(recorded_at) <= datetime(?)
      ORDER BY recorded_at ASC
    `);

    const vehicleSummaries = vehicles.map((v) => {
      const positions = positionsStmt.all(v.vehicle_id, from, to) as { recorded_at: string; odometer: number | null; fuel_liters: number | null }[];
      let minOdo: number | null = null;
      let maxOdo: number | null = null;
      let refueled = 0;
      let drained = 0;
      let prevFuel: number | null = null;
      for (const p of positions) {
        if (p.odometer && p.odometer > 0) {
          minOdo = minOdo === null ? p.odometer : Math.min(minOdo, p.odometer);
          maxOdo = maxOdo === null ? p.odometer : Math.max(maxOdo, p.odometer);
        }
        if (p.fuel_liters !== null) {
          if (prevFuel !== null) {
            const delta = p.fuel_liters - prevFuel;
            if (delta > 0) refueled += delta;
            else drained += -delta;
          }
          prevFuel = p.fuel_liters;
        }
      }
      const distanceKm = minOdo !== null && maxOdo !== null ? Math.max(0, maxOdo - minOdo) : 0;
      return {
        vehicle_id: v.vehicle_id,
        vehicle_number: v.vehicle_number,
        registration_number: v.registration_number,
        client_id: v.client_id,
        client_name: v.client_name,
        distance_km: Number(distanceKm.toFixed(1)),
        fuel_refueled_liters: Number(refueled.toFixed(1)),
        fuel_consumed_liters: Number(drained.toFixed(1)),
        fuel_efficiency_l_per_100km: distanceKm > 0 ? Number(((drained / distanceKm) * 100).toFixed(1)) : null,
        fix_count: positions.length,
        last_fix_at: positions.length ? positions[positions.length - 1].recorded_at : null,
      };
    });

    // Telemetry alert log for the range, scoped by client where applicable
    const eventSql = `
      SELECT fe.id, fe.created_at, fe.severity, fe.category, fe.rule_code, fe.description, fe.status,
             fe.vehicle_id, v.vehicle_number
      FROM fleet_exceptions fe
      LEFT JOIN vehicles v ON v.id = fe.vehicle_id
      WHERE datetime(fe.created_at) >= datetime(?) AND datetime(fe.created_at) <= datetime(?)${clause}
      ORDER BY fe.created_at DESC
    `;
    const events = db.prepare(eventSql).all(from, to, ...params);

    const totals = vehicleSummaries.reduce(
      (acc, v) => {
        acc.distance_km += v.distance_km;
        acc.fuel_refueled_liters += v.fuel_refueled_liters;
        acc.fuel_consumed_liters += v.fuel_consumed_liters;
        return acc;
      },
      { distance_km: 0, fuel_refueled_liters: 0, fuel_consumed_liters: 0 }
    );

    res.json({
      data: {
        from,
        to,
        clients_scoped: scope ?? "all",
        vehicles: vehicleSummaries,
        events,
        totals: {
          distance_km: Number(totals.distance_km.toFixed(1)),
          fuel_refueled_liters: Number(totals.fuel_refueled_liters.toFixed(1)),
          fuel_consumed_liters: Number(totals.fuel_consumed_liters.toFixed(1)),
          event_count: events.length,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * GET /api/telemetry/export?format=csv&from&to
 * CSV export of position history for the vehicles the caller may see.
 */
router.get("/export", (req, res, next) => {
  try {
    const scope = resolveClientScopes(req.user);
    const { sql: clause, params } = clientClause(scope);
    const from = (req.query.from as string) || "1970-01-01 00:00:00";
    const to = (req.query.to as string) || "2999-12-31 23:59:59";

    const rows = db.prepare(`
      SELECT v.vehicle_number, v.registration_number, p.imei, p.recorded_at, p.lat, p.lon,
             p.speed, p.heading, p.ignition, p.sats, p.fuel_liters, p.odometer, p.gsm_signal
      FROM gps_positions p
      JOIN vehicles v ON v.id = p.vehicle_id
      WHERE datetime(p.recorded_at) >= datetime(?) AND datetime(p.recorded_at) <= datetime(?)${clause}
      ORDER BY p.recorded_at DESC
      LIMIT 20000
    `).all(from, to, ...params) as any[];

    const header = ["vehicle_number", "registration_number", "imei", "recorded_at", "lat", "lon", "speed_kmh", "heading", "ignition", "sats", "fuel_liters", "odometer", "gsm_signal"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(header.map((h) => csvEscape(r[h])).join(","));
    }

    writeAudit({ userId: req.user!.id, action: "TELEMETRY_EXPORTED", entity: "gps_positions", newValue: { from, to, rows: rows.length } });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="telemetry_${from.slice(0, 10)}_${to.slice(0, 10)}.csv"`);
    res.send(lines.join("\n"));
  } catch (e) {
    next(e);
  }
});

export default router;
