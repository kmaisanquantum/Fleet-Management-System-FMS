import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, apiKeyOrAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { writeAudit } from "../utils/audit";
import { evaluateTelemetryAlerts, persistFleetAlerts, type PreviousTelemetry } from "../services/fleetAlerts";

const router = Router();

const gpsPositionSchema = z.object({
  vehicleId: z.string().optional(),
  deviceIdentifier: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  speed: z.number().default(0),
  heading: z.number().default(0),
  ignition: z.number().int().min(0).max(1).default(0),
  odometer: z.number().default(0),
  altitude: z.number().optional(),
  battery: z.number().optional(),
  source: z.string().default("telemetry"),
  recordedAt: z.string().optional(),
  geofenceStatus: z.string().default("inside"),
  // Teltonika AVL specific telemetry
  ignitionSource: z.string().optional(),
  movementSource: z.string().optional(),
  gsmSignal: z.number().int().optional(),
  externalVoltage: z.number().int().optional(),
  geofenceZoneId: z.string().optional(),
  tripOdometer: z.number().optional(),
  fuelLevelPct: z.number().optional(),
  engineRpm: z.number().int().optional(),
  engineHours: z.number().optional(),
  harshEvent: z.enum(["harsh_acceleration", "harsh_braking", "harsh_cornering", "crash"]).optional(),
  driverIdTag: z.string().optional(),
  io: z.record(z.number()).optional(),
});

/** Teltonika harsh-driving events mapped to driver_events safety-score categories. */
const HARSH_EVENT_TYPE: Record<string, string> = {
  harsh_acceleration: "harsh_accel",
  harsh_braking: "harsh_braking",
  harsh_cornering: "harsh_cornering",
  crash: "crash",
};

/** The IO element id that carries each harsh event, used to source the event magnitude. */
const HARSH_EVENT_IO: Record<string, number> = {
  harsh_acceleration: 248,
  harsh_braking: 249,
  harsh_cornering: 250,
  crash: 247,
};

const GEOFENCE_EXIT_STATES = ["exit", "exited", "outside", "out"];

function activeDriverId(vehicleId: string): string | null {
  const allocation = db
    .prepare("SELECT driver_id FROM vehicle_allocations WHERE vehicle_id = ? AND authorisation_status = 'active' LIMIT 1")
    .get(vehicleId) as { driver_id: string } | undefined;
  return allocation?.driver_id ?? null;
}

/**
 * POST /api/v1/gps/positions
 * Telematics/GPS Telemetry Ingest Endpoint
 * Supports Machine-to-Machine ingest via x-api-key header OR authenticated user JWT token.
 */
router.post("/positions", apiKeyOrAuth, (req, res, next) => {
  try {
    const input = gpsPositionSchema.parse(req.body);

    const device = input.deviceIdentifier
      ? (db
          .prepare("SELECT id, vehicle_id, client_id, device_identifier FROM gps_devices WHERE device_identifier = ?")
          .get(input.deviceIdentifier) as
          | { id: string; vehicle_id: string | null; client_id: string | null; device_identifier: string }
          | undefined)
      : undefined;

    const vehicleId = input.vehicleId ?? device?.vehicle_id;
    if (!vehicleId) {
      return res.status(400).json({
        error: "Unknown device or missing vehicle binding",
        details: `No active vehicle found associated with deviceIdentifier '${input.deviceIdentifier || "unspecified"}'`,
      });
    }

    const vehicleInfo = db
      .prepare("SELECT vehicle_number, registration_number, client_id FROM vehicles WHERE id = ?")
      .get(vehicleId) as
      | { vehicle_number: string; registration_number: string; client_id: string | null }
      | undefined;
    const boundDevice =
      device ??
      (db
        .prepare("SELECT id, client_id, device_identifier FROM gps_devices WHERE vehicle_id = ? LIMIT 1")
        .get(vehicleId) as { id: string; client_id: string | null; device_identifier: string } | undefined);

    const recordedAt = input.recordedAt || new Date().toISOString().replace("T", " ").substring(0, 19);
    const posId = uuid();

    const previousRow = db
      .prepare(`
        SELECT ignition, external_voltage_mv, lat, lon, io_json
        FROM gps_positions
        WHERE vehicle_id = ? AND datetime(recorded_at) < datetime(?)
        ORDER BY recorded_at DESC LIMIT 1
      `)
      .get(vehicleId, recordedAt) as
      | { ignition: number | null; external_voltage_mv: number | null; lat: number | null; lon: number | null; io_json: string | null }
      | undefined;
    let previousIo: Record<string, number> = {};
    if (previousRow?.io_json) {
      try { previousIo = JSON.parse(previousRow.io_json); } catch {}
    }
    const previous: PreviousTelemetry | null = previousRow
      ? {
          ignition: previousRow.ignition,
          extVoltageV: previousRow.external_voltage_mv != null ? previousRow.external_voltage_mv / 1000 : null,
          lat: previousRow.lat,
          lon: previousRow.lon,
          io: previousIo,
        }
      : null;

    db.prepare(`
      INSERT INTO gps_positions (
        id, vehicle_id, lat, lon, speed, heading, ignition, odometer, altitude_m, battery_pct,
        source, recorded_at, geofence_status, ignition_source, movement_source, gsm_signal,
        external_voltage_mv, geofence_zone_id, trip_odometer, fuel_level_pct, engine_rpm,
        engine_hours, harsh_event, driver_id_tag, io_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      posId,
      vehicleId,
      input.lat,
      input.lon,
      input.speed,
      input.heading,
      input.ignition,
      input.odometer,
      input.altitude ?? null,
      input.battery ?? null,
      input.source,
      recordedAt,
      input.geofenceStatus,
      input.ignitionSource ?? null,
      input.movementSource ?? null,
      input.gsmSignal ?? null,
      input.externalVoltage ?? null,
      input.geofenceZoneId ?? null,
      input.tripOdometer ?? null,
      input.fuelLevelPct ?? null,
      input.engineRpm ?? null,
      input.engineHours ?? null,
      input.harshEvent ?? null,
      input.driverIdTag ?? null,
      input.io ? JSON.stringify(input.io) : null
    );

    // Update vehicle live state cache fields
    db.prepare(`
      UPDATE vehicles
      SET current_latitude = ?, current_longitude = ?, current_odometer = MAX(current_odometer, ?),
          last_gps_fix_at = ?, last_seen_at = datetime('now')
      WHERE id = ?
    `).run(input.lat, input.lon, input.odometer, recordedAt, vehicleId);

    // Legacy relay ingest must stamp the same heartbeat as /api/telemetry/ingest,
    // otherwise the live map and offline watchdog treat actively reporting devices as offline.
    if (boundDevice?.id) {
      db.prepare("UPDATE gps_devices SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(boundDevice.id);
    } else {
      db.prepare("UPDATE gps_devices SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE vehicle_id = ?").run(vehicleId);
    }

    // Live-state caches for fuel level (reconciliation) and engine hours (maintenance)
    if (input.fuelLevelPct !== undefined) {
      db.prepare("UPDATE vehicles SET current_fuel_level_pct = ?, updated_at = datetime('now') WHERE id = ?").run(input.fuelLevelPct, vehicleId);
    }
    if (input.engineHours !== undefined) {
      db.prepare("UPDATE vehicles SET current_engine_hours = ?, updated_at = datetime('now') WHERE id = ?").run(input.engineHours, vehicleId);
    }

    const driverId = activeDriverId(vehicleId);

    // Harsh-driving telemetry feeds driver-intelligence safety scoring
    if (input.harshEvent) {
      const eventType = HARSH_EVENT_TYPE[input.harshEvent];
      const eventIo = HARSH_EVENT_IO[input.harshEvent];
      const magnitude = (eventIo !== undefined ? input.io?.[String(eventIo)] : undefined) ?? input.speed ?? 0;
      db.prepare(`
        INSERT INTO driver_events (id, event_type, vehicle_id, driver_id, recorded_at, value, lat, lon)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuid(), eventType, vehicleId, driverId, recordedAt, magnitude, input.lat, input.lon);
    }

    // Geofence exit creates a fleet exception via the standard mechanism
    if (GEOFENCE_EXIT_STATES.includes((input.geofenceStatus || "").toLowerCase())) {
      const excId = uuid();
      db.prepare(`
        INSERT INTO fleet_exceptions (
          id, severity, category, rule_code, vehicle_id, driver_id, gps_position_id, description, status, created_at
        ) VALUES (?, 'warning', 'geofence', 'RULE_GEOFENCE_EXIT', ?, ?, ?, ?, 'open', datetime('now'))
      `).run(
        excId,
        vehicleId,
        driverId,
        posId,
        `Vehicle exited geofence${input.geofenceZoneId ? ` zone ${input.geofenceZoneId}` : ""} at ${recordedAt}.`
      );

      db.prepare(`
        INSERT INTO audit_logs (id, action, entity, entity_id, new_value, reason, created_at)
        VALUES (?, 'EXCEPTION_CREATED', 'fleet_exceptions', ?, ?, ?, datetime('now'))
      `).run(
        uuid(),
        excId,
        JSON.stringify({ rule_code: "RULE_GEOFENCE_EXIT", vehicle_id: vehicleId }),
        "Fleet Exception triggered: RULE_GEOFENCE_EXIT"
      );
    }

    // Evaluate the same configurable alert rules as the rich ingest path so
    // legacy relay traffic (teltonika-relay and MeshSat fallback) still raises
    // overspeed, ignition, power, geofence and security alerts.
    const fleetAlertCandidates = evaluateTelemetryAlerts({
      imei: boundDevice?.device_identifier ?? input.deviceIdentifier ?? vehicleId,
      vehicleId,
      vehicleNumber: vehicleInfo?.vehicle_number ?? "Unknown vehicle",
      registrationNumber: vehicleInfo?.registration_number ?? "—",
      clientId: boundDevice?.client_id ?? vehicleInfo?.client_id ?? null,
      lat: input.lat,
      lon: input.lon,
      speed: input.speed ?? null,
      ignition: input.ignition,
      voltage: input.externalVoltage != null ? input.externalVoltage / 1000 : null,
      recordedAt,
      io: input.io ?? {},
      previous,
    });
    const insertedFleetAlerts = persistFleetAlerts(fleetAlertCandidates, {
      imei: boundDevice?.device_identifier ?? input.deviceIdentifier ?? vehicleId,
      vehicleId,
      lat: input.lat,
      lon: input.lon,
      speed: input.speed ?? null,
      voltage: input.externalVoltage != null ? input.externalVoltage / 1000 : null,
      createdAt: recordedAt,
    });

    const inserted = db.prepare("SELECT * FROM gps_positions WHERE id = ?").get(posId);
    res.status(201).json({
      data: inserted,
      fleet_alerts: insertedFleetAlerts.length,
      message: "GPS position recorded",
    });
  } catch (e) {
    next(e);
  }
});

// All remaining GET/device routes require JWT user auth
router.use(requireAuth);

/**
 * GET /api/v1/gps/latest
 * Get latest position and status for all active vehicles
 */
router.get("/latest", (_req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT
        v.id as vehicle_id,
        v.vehicle_number,
        v.registration_number,
        v.make,
        v.model,
        v.department,
        v.tank_capacity_litres,
        v.expected_km_per_l,
        v.current_odometer,
        v.current_latitude,
        v.current_longitude,
        v.current_fuel_level_pct,
        v.current_engine_hours,
        v.last_gps_fix_at,
        vsv.computed_status,
        gp.speed,
        gp.heading,
        gp.ignition,
        gp.altitude_m,
        gp.battery_pct,
        gp.source as last_signal_source,
        gp.geofence_status,
        gp.gsm_signal,
        gp.external_voltage_mv,
        gp.geofence_zone_id,
        gp.trip_odometer,
        gp.fuel_level_pct,
        gp.engine_rpm,
        gp.engine_hours,
        gp.harsh_event,
        gp.driver_id_tag,
        gp.io_json,
        (SELECT device_type FROM gps_devices WHERE vehicle_id = v.id LIMIT 1) as device_type,
        d.name as driver_name,
        d.id as driver_id
      FROM vehicles v
      LEFT JOIN vehicle_status_view vsv ON v.id = vsv.vehicle_id
      LEFT JOIN (
        SELECT p1.*
        FROM gps_positions p1
        INNER JOIN (
          SELECT vehicle_id, MAX(recorded_at) as max_rec
          FROM gps_positions
          GROUP BY vehicle_id
        ) p2 ON p1.vehicle_id = p2.vehicle_id AND p1.recorded_at = p2.max_rec
      ) gp ON v.id = gp.vehicle_id
      LEFT JOIN vehicle_allocations va ON va.vehicle_id = v.id AND va.authorisation_status = 'active'
      LEFT JOIN drivers d ON d.id = va.driver_id
      WHERE v.status != 'disposed'
      ORDER BY v.vehicle_number ASC
    `).all();

    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/gps/positions?vehicleId=
 * Get historical GPS breadcrumb positions for a specific vehicle
 */
router.get("/positions", (req, res, next) => {
  try {
    const { vehicleId, limit } = req.query;
    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId parameter is required" });
    }

    const maxRows = Math.min(Number(limit) || 100, 500);
    const rows = db.prepare(`
      SELECT * FROM gps_positions
      WHERE vehicle_id = ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(vehicleId, maxRows);

    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/gps/devices
 * List registered GPS telemetry devices (MeshSat / Teltonika)
 */
router.get("/devices", (req, res, next) => {
  try {
    const { deviceType } = req.query;
    let query = `
      SELECT
        gd.*,
        v.vehicle_number,
        v.registration_number,
        v.make,
        v.model
      FROM gps_devices gd
      LEFT JOIN vehicles v ON v.id = gd.vehicle_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (deviceType) {
      query += " AND gd.device_type = ?";
      params.push(deviceType);
    }
    query += " ORDER BY gd.created_at DESC";

    res.json({ data: db.prepare(query).all(...params) });
  } catch (e) {
    next(e);
  }
});

const registerDeviceSchema = z.object({
  deviceIdentifier: z.string().min(1),
  vehicleId: z.string().optional(),
  deviceType: z.enum(["meshsat", "teltonika"]).optional(),
  status: z.enum(["active", "inactive", "maintenance"]).default("active"),
});

/**
 * POST /api/v1/gps/devices
 * Register or update a GPS device binding (Admin/Fleet Manager)
 */
router.post("/devices", requireRole("admin", "fleet_admin", "fleet_manager"), (req, res, next) => {
  try {
    const input = registerDeviceSchema.parse(req.body);

    const existing = db.prepare("SELECT * FROM gps_devices WHERE device_identifier = ?").get(input.deviceIdentifier) as any;

    let devId: string;
    if (existing) {
      devId = existing.id;
      db.prepare(`
        UPDATE gps_devices
        SET vehicle_id = ?, status = ?, device_type = COALESCE(?, device_type), updated_at = datetime('now')
        WHERE id = ?
      `).run(input.vehicleId || null, input.status, input.deviceType ?? null, devId);
    } else {
      devId = uuid();
      db.prepare(`
        INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(devId, input.vehicleId || null, input.deviceIdentifier, input.deviceType ?? "meshsat", input.status);
    }

    // Update vehicle's gps_device_id reference if vehicleId provided
    if (input.vehicleId) {
      db.prepare("UPDATE vehicles SET gps_device_id = ? WHERE id = ?").run(devId, input.vehicleId);
    }

    writeAudit({
      userId: req.user!.id,
      action: existing ? "GPS_DEVICE_UPDATED" : "GPS_DEVICE_REGISTERED",
      entity: "gps_devices",
      entityId: devId,
      newValue: input,
    });

    const result = db.prepare(`
      SELECT gd.*, v.vehicle_number, v.registration_number
      FROM gps_devices gd
      LEFT JOIN vehicles v ON v.id = gd.vehicle_id
      WHERE gd.id = ?
    `).get(devId);

    res.status(existing ? 200 : 201).json({ data: result });
  } catch (e) {
    next(e);
  }
});

export default router;
