import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { writeAudit } from "../utils/audit";

const router = Router();
router.use(requireAuth);

const gpsPositionSchema = z.object({
  vehicleId: z.string().optional(),
  deviceIdentifier: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  speed: z.number().default(0),
  heading: z.number().default(0),
  ignition: z.number().int().min(0).max(1).default(0),
  odometer: z.number().default(0),
  recordedAt: z.string().optional(),
  geofenceStatus: z.string().default("inside"),
});

/**
 * POST /api/v1/gps/positions
 * Simulated Telematics/GPS Telemetry Ingest Endpoint
 * TODO / FUTURE: Integrate with MQTT/HTTP webhook from real telematics gateway (e.g., Geotab, Teltonika).
 */
router.post("/positions", (req, res, next) => {
  try {
    const input = gpsPositionSchema.parse(req.body);

    let vehicleId = input.vehicleId;
    if (!vehicleId && input.deviceIdentifier) {
      const dev = db.prepare("SELECT vehicle_id FROM gps_devices WHERE device_identifier = ?").get(input.deviceIdentifier) as any;
      if (dev) vehicleId = dev.vehicle_id;
    }

    if (!vehicleId) {
      return res.status(400).json({ error: "vehicleId or valid deviceIdentifier is required" });
    }

    const recordedAt = input.recordedAt || new Date().toISOString().replace("T", " ").substring(0, 19);
    const posId = uuid();

    db.prepare(`
      INSERT INTO gps_positions (id, vehicle_id, lat, lon, speed, heading, ignition, odometer, recorded_at, geofence_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(posId, vehicleId, input.lat, input.lon, input.speed, input.heading, input.ignition, input.odometer, recordedAt, input.geofenceStatus);

    // Update vehicle live state cache fields
    db.prepare(`
      UPDATE vehicles
      SET current_latitude = ?, current_longitude = ?, current_odometer = MAX(current_odometer, ?), last_gps_fix_at = ?
      WHERE id = ?
    `).run(input.lat, input.lon, input.odometer, recordedAt, vehicleId);

    const inserted = db.prepare("SELECT * FROM gps_positions WHERE id = ?").get(posId);
    res.status(201).json({ data: inserted, message: "GPS position recorded" });
  } catch (e) {
    next(e);
  }
});

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
        v.last_gps_fix_at,
        vsv.computed_status,
        gp.speed,
        gp.heading,
        gp.ignition,
        gp.geofence_status,
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

export default router;
