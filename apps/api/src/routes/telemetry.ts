import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireIngestToken } from "../middleware/auth";
import { resolveClientScope } from "../utils/scope";
import { writeAudit } from "../utils/audit";

const router = Router();

/* ------------------------------------------------------------------ *
 * Teltonika FMB125 AVL IO element interpretation
 * ------------------------------------------------------------------ */

/** Fuel level must change by at least this many litres to count as refuel/drain. */
export const FUEL_DELTA_THRESHOLD_L = 5;

export interface IoAlertRule {
  ioId: number;
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
  { ioId: 255, ruleCode: "RULE_OVERSPEED", severity: "warning", category: "telemetry", label: "Overspeed" },
  { ioId: 251, ruleCode: "RULE_EXCESSIVE_IDLING", severity: "warning", category: "telemetry", label: "Excessive idling" },
  { ioId: 252, ruleCode: "RULE_DEVICE_UNPLUG", severity: "critical", category: "security", label: "Device unplug / tamper" },
  { ioId: 246, ruleCode: "RULE_TOWING_DETECTED", severity: "critical", category: "security", label: "Towing detected" },
  { ioId: 247, ruleCode: "RULE_CRASH_DETECTED", severity: "critical", category: "driver", label: "Crash detected" },
  { ioId: 175, ruleCode: "RULE_GEOFENCE_IO", severity: "warning", category: "geofence", label: "Geofence event" },
  { ioId: 179, ruleCode: "RULE_IMMOBILIZER", severity: "warning", category: "security", label: "Immobilizer / DOUT" },
  { ioId: 253, ruleCode: "RULE_ECO_DRIVING", severity: "info", category: "driver", label: "Eco driving (harsh acceleration)" },
  { ioId: 254, ruleCode: "RULE_ECO_DRIVING", severity: "info", category: "driver", label: "Eco driving (harsh braking)" },
];

/** Geofence zone IO ids in the 155–174 block are reported as zone events. */
const GEOFENCE_ZONE_IO_MIN = 155;
const GEOFENCE_ZONE_IO_MAX = 174;

/** Well-known scalar IO elements stored on the position / live-state. */
const IO_ODOMETER = [16];
const IO_IGNITION = [239];
const IO_GSM = [21];
const IO_FUEL_COUNTER = [12, 13];

export interface InterpretedAlert {
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
 * telemetry IO (fuel counter, odometer, GSM) is captured on the position row
 * instead of producing an alert.
 */
export function interpretIoAlerts(io: Record<string, number> = {}): InterpretedAlert[] {
  const alerts: InterpretedAlert[] = [];

  for (const rule of IO_ALERT_RULES) {
    const value = io[String(rule.ioId)];
    if (value === undefined || value === null || !Number(value)) continue;
    alerts.push({
      ruleCode: rule.ruleCode,
      severity: rule.severity,
      category: rule.category,
      description: `${rule.label} (IO ${rule.ioId}=${value}).`,
      ioId: rule.ioId,
      value: Number(value),
    });
  }

  for (let id = GEOFENCE_ZONE_IO_MIN; id <= GEOFENCE_ZONE_IO_MAX; id++) {
    const value = io[String(id)];
    if (value === undefined || value === null || !Number(value)) continue;
    alerts.push({
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

/** Classifies a change in absolute fuel level as a refuel, a drain, or neither. */
export function detectFuelDelta(previous: number | null, current: number | null): "refuel" | "drain" | null {
  if (previous === null || current === null) return null;
  const delta = current - previous;
  if (delta >= FUEL_DELTA_THRESHOLD_L) return "refuel";
  if (delta <= -FUEL_DELTA_THRESHOLD_L) return "drain";
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
    const fuelLiters = input.fuel_liters ?? null;
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

    // Update vehicle live-state cache
    db.prepare(`
      UPDATE vehicles
      SET current_latitude = ?, current_longitude = ?, last_gps_fix_at = ?,
          current_odometer = MAX(current_odometer, ?), updated_at = datetime('now')
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
        fuelDeltaAlert = { ruleCode: "RULE_REFUEL_DETECTED", severity: "info", category: "fuel", description: `Refuel detected: fuel level rose from ${prev?.fuel_liters}L to ${fuelLiters}L.` };
      } else if (kind === "drain") {
        fuelDeltaAlert = { ruleCode: "RULE_FUEL_DRAIN", severity: "warning", category: "fuel", description: `Possible fuel drain: fuel level fell from ${prev?.fuel_liters}L to ${fuelLiters}L.` };
      }
    }
    if (fuelDeltaAlert) alerts.push(fuelDeltaAlert);

    // Persist alert rows (fast, one prepared insert per alert)
    const insertException = db.prepare(`
      INSERT INTO fleet_exceptions (
        id, severity, category, rule_code, vehicle_id, driver_id, gps_position_id, description, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `);
    for (const alert of alerts) {
      insertException.run(uuid(), alert.severity, alert.category, alert.ruleCode, vehicleId, driverId, posId, alert.description, recordedAt);
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
    return res.status(201).json({ data: position, alerts: alerts.length, message: "Telemetry ingested" });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * Read endpoints (JWT-authenticated, client-scoped)
 * ------------------------------------------------------------------ */

router.use(requireAuth);

/** Builds a `AND <alias>.client_id = ?` clause fragment when scoped. */
function clientClause(scope: string | null, alias = "v"): { sql: string; params: any[] } {
  if (!scope) return { sql: "", params: [] };
  return { sql: ` AND ${alias}.client_id = ?`, params: [scope] };
}

/**
 * GET /api/telemetry/latest
 * Latest position, ignition, speed, satellites and fuel for each vehicle the
 * caller may see (all vehicles for fleet roles, own client otherwise).
 */
router.get("/latest", (req, res, next) => {
  try {
    const scope = resolveClientScope(req.user);
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
    `).all(...params);

    res.json({ data: rows });
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
    const scope = resolveClientScope(req.user);
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
    const scope = resolveClientScope(req.user);
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
