import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { writeAudit } from "../utils/audit";
import {
  AssignmentError,
  DRIVER_ACTIVE_VEHICLE_JOIN,
  assignVehicleToDriver,
} from "../services/vehicleAssignments";

const router = Router();
router.use(requireAuth);

const FLEET_WRITE_ROLES = ["admin", "fleet_admin", "fleet_manager"];

/** Driver row plus the currently assigned vehicle, when there is one. */
const DRIVER_SELECT = `
  SELECT
    d.*,
    va_active.id AS assignment_id,
    va_active.vehicle_id AS assigned_vehicle_id,
    v_active.vehicle_number AS assigned_vehicle_number,
    v_active.registration_number AS assigned_vehicle_registration,
    va_active.allocation_date AS assigned_since
  FROM drivers d
  ${DRIVER_ACTIVE_VEHICLE_JOIN}
`;

router.get("/", (_req, res) => {
  const rows = db.prepare(`${DRIVER_SELECT} ORDER BY d.name ASC`).all();
  res.json({ data: rows });
});

router.get("/:id", (req, res) => {
  const driver = db.prepare(`${DRIVER_SELECT} WHERE d.id = ?`).get(req.params.id);
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  res.json({ data: driver });
});

router.get("/:id/intelligence", (req, res, next) => {
  try {
    const driverId = req.params.id;
    const profile = db.prepare(`
      SELECT
        d.*,
        va_active.id AS assignment_id,
        va_active.vehicle_id AS assigned_vehicle_id,
        v_active.vehicle_number AS assigned_vehicle_number,
        v_active.registration_number AS assigned_vehicle_registration,
        v_active.make AS assigned_vehicle_make,
        v_active.model AS assigned_vehicle_model,
        va_active.allocation_date AS assigned_since
      FROM drivers d
      ${DRIVER_ACTIVE_VEHICLE_JOIN}
      WHERE d.id = ?
    `).get(driverId) as any;

    if (!profile) return res.status(404).json({ error: "Driver not found" });

    const allocations = db.prepare(`
      SELECT va.*, v.vehicle_number, v.registration_number, v.make, v.model
      FROM vehicle_allocations va
      LEFT JOIN vehicles v ON v.id = va.vehicle_id
      WHERE va.driver_id = ?
      ORDER BY va.allocation_date DESC, va.created_at DESC
    `).all(driverId);

    const trips = db.prepare(`
      SELECT vt.*, v.vehicle_number, v.registration_number
      FROM vehicle_trips vt
      LEFT JOIN vehicles v ON v.id = vt.vehicle_id
      WHERE vt.driver_id = ?
      ORDER BY vt.date DESC, vt.created_at DESC
      LIMIT 20
    `).all(driverId);

    const fuelLogs = db.prepare(`
      SELECT fl.*, v.vehicle_number, v.registration_number
      FROM vehicle_fuel_logs fl
      LEFT JOIN vehicles v ON v.id = fl.vehicle_id
      WHERE fl.driver_id = ?
      ORDER BY fl.date DESC, fl.created_at DESC
      LIMIT 20
    `).all(driverId);

    const exceptions = db.prepare(`
      SELECT fe.*, v.vehicle_number, v.registration_number
      FROM fleet_exceptions fe
      LEFT JOIN vehicles v ON v.id = fe.vehicle_id
      WHERE fe.driver_id = ?
      ORDER BY fe.created_at DESC
      LIMIT 20
    `).all(driverId);

    const events = db.prepare(`
      SELECT de.*, v.vehicle_number, v.registration_number
      FROM driver_events de
      LEFT JOIN vehicles v ON v.id = de.vehicle_id
      WHERE de.driver_id = ?
      ORDER BY de.recorded_at DESC
      LIMIT 20
    `).all(driverId);

    const eventCounts = db.prepare(`
      SELECT event_type, COUNT(*) AS count
      FROM driver_events
      WHERE driver_id = ?
      GROUP BY event_type
    `).all(driverId) as { event_type: string; count: number }[];
    const countFor = (type: string) => eventCounts.find((e) => e.event_type === type)?.count ?? 0;

    const speedingCount = countFor("speeding");
    const harshBrakingCount = countFor("harsh_braking");
    const harshAccelCount = countFor("harsh_accel");
    const idlingCount = countFor("excessive_idling");
    const harshCorneringCount = countFor("harsh_cornering");
    const crashCount = countFor("crash");
    const safetyScore = Math.max(
      0,
      100 -
        (speedingCount * 10 +
          harshBrakingCount * 5 +
          harshAccelCount * 5 +
          idlingCount * 3 +
          harshCorneringCount * 5 +
          crashCount * 15),
    );

    const tripSummary = db.prepare(`
      SELECT COUNT(*) AS total_trips, COALESCE(SUM(total_km), 0) AS total_km
      FROM vehicle_trips WHERE driver_id = ?
    `).get(driverId) as { total_trips: number; total_km: number };

    const fuelSummary = db.prepare(`
      SELECT
        COUNT(*) AS total_refuels,
        COALESCE(SUM(litres), 0) AS total_litres,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        COALESCE(AVG(km_per_l), 0) AS avg_km_per_l
      FROM vehicle_fuel_logs WHERE driver_id = ?
    `).get(driverId) as { total_refuels: number; total_litres: number; total_cost: number; avg_km_per_l: number };

    const openExceptions = db.prepare(`
      SELECT COUNT(*) AS count FROM fleet_exceptions
      WHERE driver_id = ? AND status IN ('open', 'investigating')
    `).get(driverId) as { count: number };

    res.json({
      data: {
        profile,
        allocations,
        trips,
        fuelLogs,
        exceptions,
        events,
        metrics: {
          safetyScore,
          riskRating: safetyScore < 60 ? "high" : safetyScore < 80 ? "medium" : "low",
          speedingCount,
          harshBrakingCount,
          harshAccelCount,
          idlingCount,
          harshCorneringCount,
          crashCount,
          openExceptionsCount: openExceptions.count,
        },
        summary: {
          totalTrips: tripSummary.total_trips,
          totalKm: Number(tripSummary.total_km.toFixed(1)),
          totalRefuels: fuelSummary.total_refuels,
          totalLitres: Number(fuelSummary.total_litres.toFixed(1)),
          totalFuelCost: Number(fuelSummary.total_cost.toFixed(2)),
          avgKmPerL: Number(fuelSummary.avg_km_per_l.toFixed(1)),
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

const driverSchema = z.object({
  employeeNumber: z.string().min(1),
  name: z.string().min(1),
  department: z.string().optional(),
  licenceNumber: z.string().min(1),
  licenceClass: z.string().optional(),
  licenceExpiry: z.string().min(1),
  authorisationStatus: z.enum(["authorised", "suspended", "revoked", "pending"]).default("authorised"),
  accidentHistory: z.string().optional(),
  training: z.string().optional(),
});

router.post("/", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const input = driverSchema.parse(req.body);
    const id = uuid();
    db.prepare(`
      INSERT INTO drivers (
        id, employee_number, name, department, licence_number, licence_class,
        licence_expiry, authorisation_status, accident_history, training
      ) VALUES (
        @id, @employeeNumber, @name, @department, @licenceNumber, @licenceClass,
        @licenceExpiry, @authorisationStatus, @accidentHistory, @training
      )
    `).run({
      id,
      employeeNumber: input.employeeNumber,
      name: input.name,
      department: input.department ?? null,
      licenceNumber: input.licenceNumber,
      licenceClass: input.licenceClass ?? null,
      licenceExpiry: input.licenceExpiry,
      authorisationStatus: input.authorisationStatus,
      accidentHistory: input.accidentHistory ?? null,
      training: input.training ?? null,
    });

    writeAudit({ userId: req.user!.id, action: "DRIVER_CREATED", entity: "drivers", entityId: id, newValue: input });
    const created = db.prepare("SELECT * FROM drivers WHERE id = ?").get(id);
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.put("/:id", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const input = driverSchema.partial().parse(req.body);
    const existing = db.prepare("SELECT * FROM drivers WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Driver not found" });

    db.prepare(`
      UPDATE drivers SET
        name = COALESCE(@name, name),
        department = COALESCE(@department, department),
        licence_number = COALESCE(@licenceNumber, licence_number),
        licence_class = COALESCE(@licenceClass, licence_class),
        licence_expiry = COALESCE(@licenceExpiry, licence_expiry),
        authorisation_status = COALESCE(@authorisationStatus, authorisation_status),
        accident_history = COALESCE(@accidentHistory, accident_history),
        training = COALESCE(@training, training),
        updated_at = datetime('now')
      WHERE id = @id
    `).run({
      id: req.params.id,
      name: input.name ?? null,
      department: input.department ?? null,
      licenceNumber: input.licenceNumber ?? null,
      licenceClass: input.licenceClass ?? null,
      licenceExpiry: input.licenceExpiry ?? null,
      authorisationStatus: input.authorisationStatus ?? null,
      accidentHistory: input.accidentHistory ?? null,
      training: input.training ?? null,
    });

    writeAudit({ userId: req.user!.id, action: "DRIVER_UPDATED", entity: "drivers", entityId: req.params.id, newValue: input });
    const updated = db.prepare("SELECT * FROM drivers WHERE id = ?").get(req.params.id);
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.put("/:id/vehicle", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const { vehicleId } = z.object({ vehicleId: z.string().min(1).nullable() }).parse(req.body);
    const assignment = assignVehicleToDriver(req.params.id, vehicleId, req.user!.id);
    res.json({ data: assignment });
  } catch (e) {
    if (e instanceof AssignmentError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.delete("/:id", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM drivers WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Driver not found" });

    db.prepare("DELETE FROM drivers WHERE id = ?").run(req.params.id);
    writeAudit({ userId: req.user!.id, action: "DRIVER_DELETED", entity: "drivers", entityId: req.params.id, previousValue: existing });
    res.status(204).end();
  } catch (e: any) {
    if (e.code && e.code.includes("SQLITE_CONSTRAINT")) {
      return res.status(400).json({ error: "Cannot delete driver with linked records" });
    }
    next(e);
  }
});

export default router;
