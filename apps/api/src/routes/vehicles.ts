import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { writeAudit } from "../utils/audit";

const router = Router();
router.use(requireAuth);

const FLEET_WRITE_ROLES = ["admin", "fleet_admin", "fleet_manager"];

router.get("/", (req, res) => {
  const { status, department } = req.query;
  let query = "SELECT * FROM vehicles WHERE 1=1";
  const params: any[] = [];
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }
  if (department) {
    query += " AND department = ?";
    params.push(department);
  }
  query += " ORDER BY vehicle_number ASC";
  const rows = db.prepare(query).all(...params);
  res.json({ data: rows });
});

router.get("/:id", (req, res) => {
  const vehicle = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(req.params.id);
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
  res.json({ data: vehicle });
});

/**
 * GET /api/v1/vehicles/:id/intelligence
 * Tabbed intelligence profile (profile, operational, fuel, maintenance, driver, exceptions)
 */
router.get("/:id/intelligence", (req, res, next) => {
  try {
    const vehicleId = req.params.id;
    const profile = db.prepare(`
      SELECT
        v.*,
        vsv.computed_status,
        fc.card_number,
        gd.device_identifier
      FROM vehicles v
      LEFT JOIN vehicle_status_view vsv ON vsv.vehicle_id = v.id
      LEFT JOIN fuel_cards fc ON fc.id = v.fuel_card_id
      LEFT JOIN gps_devices gd ON gd.id = v.gps_device_id
      WHERE v.id = ?
    `).get(vehicleId) as any;

    if (!profile) {
      return res.status(404).json({ error: "Vehicle not found" });
    }

    // Operational: latest GPS position
    const latestGps = db.prepare(`
      SELECT * FROM gps_positions
      WHERE vehicle_id = ?
      ORDER BY recorded_at DESC
      LIMIT 1
    `).get(vehicleId);

    // Operational: Trips summary
    const tripSummary = db.prepare(`
      SELECT
        COUNT(*) as total_trips,
        COALESCE(SUM(total_km), 0) as total_distance_km
      FROM vehicle_trips
      WHERE vehicle_id = ?
    `).get(vehicleId);

    // Fuel: Logs & aggregates
    const fuelLogs = db.prepare(`
      SELECT fl.*, fs.name as station_name
      FROM vehicle_fuel_logs fl
      LEFT JOIN fuel_stations fs ON fs.id = fl.station_id
      WHERE fl.vehicle_id = ?
      ORDER BY fl.date DESC, fl.created_at DESC
      LIMIT 10
    `).all(vehicleId);

    const fuelSummary = db.prepare(`
      SELECT
        COUNT(*) as total_refuels,
        COALESCE(SUM(litres), 0) as total_litres,
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(AVG(km_per_l), 0) as avg_km_per_l,
        SUM(CASE WHEN reconciliation_status = 'verified' THEN 1 ELSE 0 END) as verified_count,
        SUM(CASE WHEN reconciliation_status = 'exception' THEN 1 ELSE 0 END) as exception_count
      FROM vehicle_fuel_logs
      WHERE vehicle_id = ?
    `).get(vehicleId);

    // Maintenance: Past & scheduled
    const maintenanceRecords = db.prepare(`
      SELECT * FROM vehicle_maintenance
      WHERE vehicle_id = ?
      ORDER BY scheduled_date DESC
    `).all(vehicleId);

    // Driver: Current allocation & history
    const allocations = db.prepare(`
      SELECT va.*, d.name as driver_name, d.employee_number, d.licence_number
      FROM vehicle_allocations va
      LEFT JOIN drivers d ON d.id = va.driver_id
      WHERE va.vehicle_id = ?
      ORDER BY va.allocation_date DESC
    `).all(vehicleId);

    // Exceptions
    const exceptions = db.prepare(`
      SELECT * FROM fleet_exceptions
      WHERE vehicle_id = ?
      ORDER BY created_at DESC
    `).all(vehicleId);

    res.json({
      data: {
        profile,
        operational: {
          currentStatus: profile.computed_status || profile.status,
          currentOdometer: profile.current_odometer,
          currentLatitude: profile.current_latitude,
          currentLongitude: profile.current_longitude,
          lastGpsFixAt: profile.last_gps_fix_at,
          latestGps,
          tripSummary,
        },
        fuel: {
          summary: fuelSummary,
          recentLogs: fuelLogs,
          cardInfo: profile.card_number ? { id: profile.fuel_card_id, number: profile.card_number } : null,
        },
        maintenance: {
          records: maintenanceRecords,
        },
        driver: {
          allocations,
          currentDriver: allocations.find((a: any) => a.authorisation_status === "active") || null,
        },
        exceptions,
      },
    });
  } catch (e) {
    next(e);
  }
});

const vehicleSchema = z.object({
  vehicleNumber: z.string().min(1),
  registrationNumber: z.string().min(1),
  make: z.string().min(1),
  model: z.string().min(1),
  year: z.number().optional(),
  vehicleType: z.string().min(1),
  chassisVin: z.string().optional(),
  engineNumber: z.string().optional(),
  colour: z.string().optional(),
  fuelType: z.string().min(1),
  department: z.string().optional(),
  location: z.string().optional(),
  status: z.enum(["active", "inactive", "under_repair", "disposed"]).default("active"),
  acquisitionDate: z.string().optional(),
  acquisitionCost: z.number().optional(),
  currentValue: z.number().optional(),
  ownership: z.enum(["owned", "leased", "hired", "other"]).default("owned"),
  insurancePolicy: z.string().optional(),
  insuranceExpiry: z.string().optional(),
  registrationExpiry: z.string().optional(),
  tankCapacityLitres: z.number().optional(),
  expectedKmPerL: z.number().optional(),
});

router.post("/", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const input = vehicleSchema.parse(req.body);
    const id = uuid();
    db.prepare(`
      INSERT INTO vehicles (
        id, vehicle_number, registration_number, make, model, year, vehicle_type,
        chassis_vin, engine_number, colour, fuel_type, department, location, status,
        acquisition_date, acquisition_cost, current_value, ownership, insurance_policy,
        insurance_expiry, registration_expiry, tank_capacity_litres, expected_km_per_l
      ) VALUES (
        @id, @vehicleNumber, @registrationNumber, @make, @model, @year, @vehicleType,
        @chassisVin, @engineNumber, @colour, @fuelType, @department, @location, @status,
        @acquisitionDate, @acquisitionCost, @currentValue, @ownership, @insurancePolicy,
        @insuranceExpiry, @registrationExpiry, @tankCapacityLitres, @expectedKmPerL
      )
    `).run({
      id,
      vehicleNumber: input.vehicleNumber,
      registrationNumber: input.registrationNumber,
      make: input.make,
      model: input.model,
      year: input.year ?? null,
      vehicleType: input.vehicleType,
      chassisVin: input.chassisVin ?? null,
      engineNumber: input.engineNumber ?? null,
      colour: input.colour ?? null,
      fuelType: input.fuelType,
      department: input.department ?? null,
      location: input.location ?? null,
      status: input.status,
      acquisitionDate: input.acquisitionDate ?? null,
      acquisitionCost: input.acquisitionCost ?? null,
      currentValue: input.currentValue ?? null,
      ownership: input.ownership,
      insurancePolicy: input.insurancePolicy ?? null,
      insuranceExpiry: input.insuranceExpiry ?? null,
      registrationExpiry: input.registrationExpiry ?? null,
      tankCapacityLitres: input.tankCapacityLitres ?? 80.0,
      expectedKmPerL: input.expectedKmPerL ?? 8.0,
    });

    writeAudit({ userId: req.user!.id, action: "VEHICLE_CREATED", entity: "vehicles", entityId: id, newValue: input });
    const created = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(id);
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.put("/:id", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const input = vehicleSchema.partial().parse(req.body);
    const existing = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "Vehicle not found" });

    db.prepare(`
      UPDATE vehicles SET
        registration_number = COALESCE(@registrationNumber, registration_number),
        make = COALESCE(@make, make),
        model = COALESCE(@model, model),
        year = COALESCE(@year, year),
        vehicle_type = COALESCE(@vehicleType, vehicle_type),
        chassis_vin = COALESCE(@chassisVin, chassis_vin),
        engine_number = COALESCE(@engineNumber, engine_number),
        colour = COALESCE(@colour, colour),
        fuel_type = COALESCE(@fuelType, fuel_type),
        department = COALESCE(@department, department),
        location = COALESCE(@location, location),
        status = COALESCE(@status, status),
        acquisition_date = COALESCE(@acquisitionDate, acquisition_date),
        acquisition_cost = COALESCE(@acquisitionCost, acquisition_cost),
        current_value = COALESCE(@currentValue, current_value),
        ownership = COALESCE(@ownership, ownership),
        insurance_policy = COALESCE(@insurancePolicy, insurance_policy),
        insurance_expiry = COALESCE(@insuranceExpiry, insurance_expiry),
        registration_expiry = COALESCE(@registrationExpiry, registration_expiry),
        tank_capacity_litres = COALESCE(@tankCapacityLitres, tank_capacity_litres),
        expected_km_per_l = COALESCE(@expectedKmPerL, expected_km_per_l),
        updated_at = datetime('now')
      WHERE id = @id
    `).run({
      id: req.params.id,
      registrationNumber: input.registrationNumber ?? null,
      make: input.make ?? null,
      model: input.model ?? null,
      year: input.year ?? null,
      vehicleType: input.vehicleType ?? null,
      chassisVin: input.chassisVin ?? null,
      engineNumber: input.engineNumber ?? null,
      colour: input.colour ?? null,
      fuelType: input.fuelType ?? null,
      department: input.department ?? null,
      location: input.location ?? null,
      status: input.status ?? null,
      acquisitionDate: input.acquisitionDate ?? null,
      acquisitionCost: input.acquisitionCost ?? null,
      currentValue: input.currentValue ?? null,
      ownership: input.ownership ?? null,
      insurancePolicy: input.insurancePolicy ?? null,
      insuranceExpiry: input.insuranceExpiry ?? null,
      registrationExpiry: input.registrationExpiry ?? null,
      tankCapacityLitres: input.tankCapacityLitres ?? null,
      expectedKmPerL: input.expectedKmPerL ?? null,
    });

    writeAudit({ userId: req.user!.id, action: "VEHICLE_UPDATED", entity: "vehicles", entityId: req.params.id, previousValue: existing, newValue: input });
    const updated = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(req.params.id);
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.patch("/:id/status", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(["active", "inactive", "under_repair", "disposed"]) }).parse(req.body);
    db.prepare("UPDATE vehicles SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
    writeAudit({ userId: req.user!.id, action: "VEHICLE_STATUS_CHANGED", entity: "vehicles", entityId: req.params.id, newValue: { status } });
    res.json({ data: db.prepare("SELECT * FROM vehicles WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

router.delete("/:id", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Vehicle not found" });

    db.prepare("DELETE FROM vehicles WHERE id = ?").run(req.params.id);
    writeAudit({ userId: req.user!.id, action: "VEHICLE_DELETED", entity: "vehicles", entityId: req.params.id, previousValue: existing });
    res.status(204).end();
  } catch (e: any) {
    if (e.code && e.code.includes("SQLITE_CONSTRAINT")) {
      return res.status(400).json({ error: "Cannot delete vehicle with linked records" });
    }
    next(e);
  }
});

export default router;
