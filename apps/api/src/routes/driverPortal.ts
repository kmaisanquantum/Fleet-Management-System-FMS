import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { ApiError } from "../middleware/errorHandler";
import { collectFileInfos, uploadFilesMiddleware } from "../middleware/upload";
import {
  auditDriverAction,
  computeSafety,
  createAlert,
  createNotification,
  flagVehicleUnderRepair,
  getAssignedVehicle,
  getDriver,
  getVehicleBlockReason,
  requireDriverContext,
} from "../services/driverPortal";

const router = Router();

// Every Driver Portal endpoint requires an authenticated `driver` role.
router.use(requireAuth);
router.use(requireRole("driver"));

/* ------------------------------------------------------------------ */
/* Inspection checklist definition (criticality is decided server-side) */
/* ------------------------------------------------------------------ */

export const CHECKLIST_ITEMS: { key: string; label: string; critical: boolean }[] = [
  { key: "tyres", label: "Tyres", critical: true },
  { key: "brakes", label: "Brakes", critical: true },
  { key: "lights", label: "Lights", critical: true },
  { key: "indicators", label: "Indicators", critical: false },
  { key: "engine", label: "Engine", critical: true },
  { key: "oil", label: "Engine Oil", critical: false },
  { key: "coolant", label: "Coolant", critical: false },
  { key: "battery", label: "Battery", critical: false },
  { key: "mirrors", label: "Mirrors", critical: false },
  { key: "windscreen", label: "Windscreen", critical: false },
  { key: "wipers", label: "Wipers", critical: false },
  { key: "seatbelts", label: "Seatbelts", critical: true },
  { key: "horn", label: "Horn", critical: false },
  { key: "safety_equipment", label: "Safety Equipment", critical: true },
];

const CHECKLIST_KEYS = new Set(CHECKLIST_ITEMS.map((i) => i.key));

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Distance / odometer anomaly detection mirroring vehicleTrips. */
function computeAnomaly(vehicleId: string, date: string, beginOdometer: number, endOdometer: number): number {
  if (endOdometer < beginOdometer) return 1;
  const prev = db.prepare(`
    SELECT end_odometer FROM vehicle_trips
    WHERE vehicle_id = ? AND date <= ? AND time_in IS NOT NULL
    ORDER BY date DESC, created_at DESC LIMIT 1
  `).get(vehicleId, date) as { end_odometer: number } | undefined;
  if (prev && beginOdometer < prev.end_odometer) return 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

router.get("/dashboard", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const vehicle = getAssignedVehicle(driverId) ?? null;

    const todaysTrips = db.prepare(`
      SELECT vt.*, v.vehicle_number
      FROM vehicle_trips vt
      JOIN vehicles v ON v.id = vt.vehicle_id
      WHERE vt.driver_id = ? AND vt.date = date('now')
      ORDER BY vt.created_at DESC
    `).all(driverId) as any[];

    const km = db.prepare("SELECT COALESCE(SUM(total_km), 0) AS total_km FROM vehicle_trips WHERE driver_id = ?").get(driverId) as { total_km: number };
    const fuel = db.prepare(`
      SELECT COALESCE(SUM(litres), 0) AS litres, COALESCE(SUM(total_cost), 0) AS cost, COALESCE(AVG(km_per_l), 0) AS avg_km_per_l
      FROM vehicle_fuel_logs WHERE driver_id = ?
    `).get(driverId) as { litres: number; cost: number; avg_km_per_l: number };

    // Pending inspection = assigned vehicle has no completed inspection today.
    let pendingInspections = 0;
    if (vehicle) {
      const todays = db.prepare(`
        SELECT COUNT(*) AS count FROM vehicle_inspections
        WHERE vehicle_id = ? AND date(inspection_date) = date('now')
      `).get(vehicle.id) as { count: number };
      pendingInspections = todays.count === 0 ? 1 : 0;
    }

    const safety = computeSafety(driverId);

    const openFaults = db.prepare(`
      SELECT COUNT(*) AS count FROM vehicle_faults
      WHERE driver_id = ? AND status IN ('open', 'acknowledged', 'in_progress')
    `).get(driverId) as { count: number };

    const unread = db.prepare("SELECT COUNT(*) AS count FROM driver_notifications WHERE user_id = ? AND is_read = 0").get(req.user!.id) as { count: number };
    const notifications = db.prepare(`
      SELECT * FROM driver_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
    `).all(req.user!.id);

    res.json({
      data: {
        assignedVehicle: vehicle,
        vehicleBlockReason: vehicle ? getVehicleBlockReason(vehicle.id) : null,
        todaysTrips,
        metrics: {
          totalKm: Number((km.total_km ?? 0).toFixed(1)),
          totalFuelLitres: Number((fuel.litres ?? 0).toFixed(2)),
          totalFuelCost: Number((fuel.cost ?? 0).toFixed(2)),
          avgKmPerL: Number((fuel.avg_km_per_l ?? 0).toFixed(2)),
          pendingInspections,
          safetyScore: safety.safetyScore,
          riskRating: safety.riskRating,
          openFaults: openFaults.count,
          unreadNotifications: unread.count,
        },
        notifications,
      },
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Profile / vehicle                                                   */
/* ------------------------------------------------------------------ */

router.get("/profile", (req, res, next) => {
  try {
    const { driverId, userId } = requireDriverContext(req);
    const driver = getDriver(driverId);
    if (!driver) throw new ApiError(404, "Driver record not found");
    const user = db.prepare("SELECT email, full_name, status FROM users WHERE id = ?").get(userId) as any;
    res.json({
      data: {
        id: driver.id,
        employeeNumber: driver.employee_number,
        name: driver.name,
        department: driver.department,
        licenceNumber: driver.licence_number,
        licenceClass: driver.licence_class,
        licenceExpiry: driver.licence_expiry,
        authorisationStatus: driver.authorisation_status,
        accidentHistory: driver.accident_history,
        training: driver.training,
        email: user?.email ?? null,
        fullName: user?.full_name ?? driver.name,
        accountStatus: user?.status ?? null,
      },
    });
  } catch (e) { next(e); }
});

router.get("/vehicle", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const vehicle = getAssignedVehicle(driverId) ?? null;
    res.json({ data: vehicle ? { ...vehicle, blockReason: getVehicleBlockReason(vehicle.id) } : null });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Trips                                                               */
/* ------------------------------------------------------------------ */

router.get("/trips", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const rows = db.prepare(`
      SELECT vt.*, v.vehicle_number, v.registration_number
      FROM vehicle_trips vt
      JOIN vehicles v ON v.id = vt.vehicle_id
      WHERE vt.driver_id = ?
      ORDER BY vt.date DESC, vt.created_at DESC
    `).all(driverId) as any[];
    const active = rows.find((r) => r.time_in === null) ?? null;
    res.json({
      data: rows,
      activeTrip: active,
      summary: {
        totalTrips: rows.length,
        totalKm: Number(rows.reduce((acc, r) => acc + (r.total_km || 0), 0).toFixed(1)),
      },
    });
  } catch (e) { next(e); }
});

const tripStartSchema = z.object({
  vehicleId: z.string().optional(),
  startLocation: z.string().min(1),
  destination: z.string().min(1),
  purpose: z.string().optional(),
  beginOdometer: z.number().nonnegative(),
});

router.post("/trips/start", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const input = tripStartSchema.parse(req.body);

    const assigned = getAssignedVehicle(driverId);
    if (!assigned) throw new ApiError(400, "No vehicle is currently assigned to you");
    if (input.vehicleId && input.vehicleId !== assigned.id) {
      throw new ApiError(403, "You can only start trips on your assigned vehicle");
    }

    const blockReason = getVehicleBlockReason(assigned.id);
    if (blockReason) throw new ApiError(409, `Cannot start trip: ${blockReason}`);

    const active = db.prepare("SELECT id FROM vehicle_trips WHERE driver_id = ? AND time_in IS NULL").get(driverId);
    if (active) throw new ApiError(409, "You already have a trip in progress. End it before starting a new one.");

    const id = uuid();
    const date = today();
    const timeOut = nowTime();
    db.prepare(`
      INSERT INTO vehicle_trips (
        id, vehicle_id, driver_id, date, time_out, time_in, start_location,
        destination, purpose, begin_odometer, end_odometer, total_km, odometer_anomaly
      ) VALUES (
        @id, @vehicleId, @driverId, @date, @timeOut, NULL, @startLocation,
        @destination, @purpose, @beginOdometer, @beginOdometer, 0, 0
      )
    `).run({
      id,
      vehicleId: assigned.id,
      driverId,
      date,
      timeOut,
      startLocation: input.startLocation,
      destination: input.destination,
      purpose: input.purpose ?? null,
      beginOdometer: input.beginOdometer,
    });

    auditDriverAction(req, "DRIVER_TRIP_STARTED", "vehicle_trips", id, { ...input, vehicleId: assigned.id, date, timeOut });
    res.status(201).json({ data: db.prepare("SELECT * FROM vehicle_trips WHERE id = ?").get(id) });
  } catch (e) { next(e); }
});

const tripEndSchema = z.object({
  endOdometer: z.number().nonnegative(),
  destination: z.string().min(1).optional(),
});

router.post("/trips/:id/end", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const input = tripEndSchema.parse(req.body);

    const trip = db.prepare("SELECT * FROM vehicle_trips WHERE id = ? AND driver_id = ? AND time_in IS NULL").get(req.params.id, driverId) as any;
    if (!trip) throw new ApiError(404, "Active trip not found");

    const totalKm = Number(Math.max(0, input.endOdometer - trip.begin_odometer).toFixed(1));
    const anomaly = computeAnomaly(trip.vehicle_id, trip.date, trip.begin_odometer, input.endOdometer);
    const timeIn = nowTime();

    db.prepare(`
      UPDATE vehicle_trips
      SET end_odometer = @endOdometer, total_km = @totalKm, time_in = @timeIn,
          odometer_anomaly = @anomaly, destination = COALESCE(@destination, destination)
      WHERE id = @id AND driver_id = @driverId
    `).run({
      id: trip.id,
      driverId,
      endOdometer: input.endOdometer,
      totalKm,
      timeIn,
      anomaly,
      destination: input.destination ?? null,
    });

    db.prepare(`
      UPDATE vehicles SET current_odometer = MAX(COALESCE(current_odometer, 0), ?), updated_at = datetime('now') WHERE id = ?
    `).run(input.endOdometer, trip.vehicle_id);

    auditDriverAction(req, "DRIVER_TRIP_ENDED", "vehicle_trips", trip.id, { ...input, totalKm, anomaly, timeIn }, trip);
    res.json({ data: db.prepare("SELECT * FROM vehicle_trips WHERE id = ?").get(trip.id) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Inspections                                                         */
/* ------------------------------------------------------------------ */

router.get("/inspections/checklist", (_req, res) => {
  res.json({ data: CHECKLIST_ITEMS });
});

router.get("/inspections", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const inspections = db.prepare(`
      SELECT vi.*, v.vehicle_number
      FROM vehicle_inspections vi
      JOIN vehicles v ON v.id = vi.vehicle_id
      WHERE vi.driver_id = ? OR vi.inspector_id = ?
      ORDER BY vi.inspection_date DESC, vi.created_at DESC
    `).all(driverId, req.user!.id) as any[];

    const itemsByInspection: Record<string, any[]> = {};
    for (const insp of inspections) {
      itemsByInspection[insp.id] = db.prepare("SELECT * FROM inspection_items WHERE inspection_id = ?").all(insp.id) as any[];
    }
    res.json({ data: inspections.map((i) => ({ ...i, items: itemsByInspection[i.id] ?? [] })) });
  } catch (e) { next(e); }
});

const inspectionSchema = z.object({
  inspectionDate: z.string().min(1).optional(),
  items: z.array(z.object({
    key: z.string().min(1),
    status: z.enum(["satisfactory", "defective", "na"]),
    comment: z.string().optional(),
  })).min(1),
  photoUrls: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

router.post("/inspections", (req, res, next) => {
  try {
    const { driverId, userId } = requireDriverContext(req);
    const input = inspectionSchema.parse(req.body);

    const assigned = getAssignedVehicle(driverId);
    if (!assigned) throw new ApiError(400, "No vehicle is currently assigned to you");

    // Validate checklist keys and derive criticality server-side.
    for (const item of input.items) {
      if (!CHECKLIST_KEYS.has(item.key)) throw new ApiError(400, `Unknown checklist item: ${item.key}`);
    }

    const defectItems = input.items.filter((i) => i.status === "defective");
    const criticalDefects = defectItems.filter((i) => CHECKLIST_ITEMS.find((c) => c.key === i.key)?.critical);
    const result: "pass" | "fail" | "requires_attention" = criticalDefects.length > 0 ? "fail" : defectItems.length > 0 ? "requires_attention" : "pass";

    const inspectionId = uuid();
    const checklistJson = JSON.stringify(input.items.map((i) => ({ key: i.key, status: i.status, comment: i.comment ?? null })));

    db.prepare(`
      INSERT INTO vehicle_inspections (
        id, vehicle_id, inspector_id, driver_id, inspector_name, inspection_date, result, checklist, photo_urls, cleared, notes
      ) VALUES (
        @id, @vehicleId, @inspectorId, @driverId, @inspectorName, @inspectionDate, @result, @checklist, @photoUrls, 0, @notes
      )
    `).run({
      id: inspectionId,
      vehicleId: assigned.id,
      inspectorId: userId,
      driverId,
      inspectorName: req.user!.email ?? "Driver",
      inspectionDate: input.inspectionDate ?? today(),
      result,
      checklist: checklistJson,
      photoUrls: JSON.stringify(input.photoUrls ?? []),
      notes: input.notes ?? null,
    });

    const insertItem = db.prepare(`
      INSERT INTO inspection_items (id, inspection_id, item_key, label, status, is_critical, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const item of input.items) {
        const def = CHECKLIST_ITEMS.find((c) => c.key === item.key)!;
        insertItem.run(uuid(), inspectionId, item.key, def.label, item.status, def.critical ? 1 : 0, item.comment ?? null);
      }
    });
    tx();

    // Critical defect → flag vehicle, raise alert + fault, notify driver.
    if (criticalDefects.length > 0) {
      const labels = criticalDefects.map((d) => CHECKLIST_ITEMS.find((c) => c.key === d.key)?.label ?? d.key).join(", ");
      flagVehicleUnderRepair(assigned.id);
      createAlert("critical", "vehicle", assigned.id, "daily_inspection_failed",
        `Daily inspection CRITICAL FAIL for vehicle ${assigned.vehicle_number} on ${input.inspectionDate ?? today()}: ${labels}`);
      db.prepare(`
        INSERT INTO vehicle_faults (id, vehicle_id, driver_id, reported_by_user_id, category, description, severity, status)
        VALUES (?, ?, ?, ?, 'inspection', ?, 'critical', 'open')
      `).run(uuid(), assigned.id, driverId, userId, `Critical defect(s) found during daily inspection: ${labels}`);
      createNotification({
        userId, driverId, title: "Vehicle flagged after inspection",
        body: `Your vehicle ${assigned.vehicle_number} was flagged under repair due to critical defect(s): ${labels}. It cannot start trips until an administrator clears it.`,
        category: "inspection", relatedEntity: "vehicle_inspections", relatedId: inspectionId,
      });
    }

    auditDriverAction(req, "DRIVER_INSPECTION_SUBMITTED", "vehicle_inspections", inspectionId, { result, criticalDefects: criticalDefects.length, items: input.items.length });
    const created = db.prepare("SELECT * FROM vehicle_inspections WHERE id = ?").get(inspectionId);
    const createdItems = db.prepare("SELECT * FROM inspection_items WHERE inspection_id = ?").all(inspectionId);
    res.status(201).json({ data: { ...(created as any), items: createdItems } });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Fuel                                                                */
/* ------------------------------------------------------------------ */

router.get("/fuel", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const rows = db.prepare(`
      SELECT fl.*, v.vehicle_number
      FROM vehicle_fuel_logs fl
      JOIN vehicles v ON v.id = fl.vehicle_id
      WHERE fl.driver_id = ?
      ORDER BY fl.date DESC, fl.created_at DESC
    `).all(driverId) as any[];
    res.json({
      data: rows,
      summary: {
        totalLitres: Number(rows.reduce((a, r) => a + (r.litres || 0), 0).toFixed(2)),
        totalCost: Number(rows.reduce((a, r) => a + (r.total_cost || 0), 0).toFixed(2)),
      },
    });
  } catch (e) { next(e); }
});

const fuelSchema = z.object({
  date: z.string().min(1).optional(),
  time: z.string().optional(),
  station: z.string().min(1),
  fuelType: z.string().min(1),
  litres: z.number().positive(),
  costPerLitre: z.number().positive(),
  odometerReading: z.number().nonnegative(),
  receiptRef: z.string().optional(),
  receiptUrl: z.string().optional(),
});

router.post("/fuel", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const input = fuelSchema.parse(req.body);

    const assigned = getAssignedVehicle(driverId);
    if (!assigned) throw new ApiError(400, "No vehicle is currently assigned to you");

    const totalCost = Number((input.litres * input.costPerLitre).toFixed(2));

    const prevLog = db.prepare(`
      SELECT odometer_reading FROM vehicle_fuel_logs
      WHERE vehicle_id = ? AND date <= ?
      ORDER BY date DESC, created_at DESC LIMIT 1
    `).get(assigned.id, input.date ?? today()) as { odometer_reading: number } | undefined;

    let lPer100km: number | null = null;
    let kmPerL: number | null = null;
    let costPerKm: number | null = null;
    if (prevLog && input.odometerReading > prevLog.odometer_reading) {
      const distance = input.odometerReading - prevLog.odometer_reading;
      lPer100km = Number(((input.litres / distance) * 100).toFixed(2));
      kmPerL = Number((distance / input.litres).toFixed(2));
      costPerKm = Number((totalCost / distance).toFixed(2));
    }

    const id = uuid();
    db.prepare(`
      INSERT INTO vehicle_fuel_logs (
        id, vehicle_id, driver_id, date, time, station, fuel_type, litres,
        cost_per_litre, total_cost, odometer_reading, payment_method, receipt_ref,
        receipt_url, l_per_100km, km_per_l, cost_per_km, source, reconciliation_status
      ) VALUES (
        @id, @vehicleId, @driverId, @date, @time, @station, @fuelType, @litres,
        @costPerLitre, @totalCost, @odometerReading, 'Driver Portal', @receiptRef,
        @receiptUrl, @lPer100km, @kmPerL, @costPerKm, 'manual', 'pending'
      )
    `).run({
      id,
      vehicleId: assigned.id,
      driverId,
      date: input.date ?? today(),
      time: input.time ?? nowTime(),
      station: input.station,
      fuelType: input.fuelType,
      litres: input.litres,
      costPerLitre: input.costPerLitre,
      totalCost,
      odometerReading: input.odometerReading,
      receiptRef: input.receiptRef ?? null,
      receiptUrl: input.receiptUrl ?? null,
      lPer100km,
      kmPerL,
      costPerKm,
    });

    auditDriverAction(req, "DRIVER_FUEL_LOGGED", "vehicle_fuel_logs", id, { ...input, totalCost, vehicleId: assigned.id });
    res.status(201).json({ data: db.prepare("SELECT * FROM vehicle_fuel_logs WHERE id = ?").get(id) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Faults                                                              */
/* ------------------------------------------------------------------ */

router.get("/faults", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const rows = db.prepare(`
      SELECT vf.*, v.vehicle_number
      FROM vehicle_faults vf
      JOIN vehicles v ON v.id = vf.vehicle_id
      WHERE vf.driver_id = ?
      ORDER BY vf.created_at DESC
    `).all(driverId) as any[];
    res.json({ data: rows });
  } catch (e) { next(e); }
});

const faultSchema = z.object({
  category: z.enum(["engine", "brakes", "tyres", "electrical", "transmission", "body", "cooling", "steering", "other"]),
  description: z.string().min(3),
  severity: z.enum(["minor", "major", "critical"]),
  odometer: z.number().nonnegative().optional(),
  photoUrls: z.array(z.string()).optional(),
});

router.post("/faults", (req, res, next) => {
  try {
    const { driverId, userId } = requireDriverContext(req);
    const input = faultSchema.parse(req.body);

    const assigned = getAssignedVehicle(driverId);
    if (!assigned) throw new ApiError(400, "No vehicle is currently assigned to you");

    const id = uuid();
    // Major/critical faults are raised into the maintenance module for tracking.
    let maintenanceId: string | null = null;
    if (input.severity !== "minor") {
      maintenanceId = uuid();
      db.prepare(`
        INSERT INTO vehicle_maintenance (
          id, vehicle_id, driver_id, requested_by, maintenance_type, description, status
        ) VALUES (?, ?, ?, ?, 'unscheduled_repair', ?, 'scheduled')
      `).run(maintenanceId, assigned.id, driverId, userId, `[${input.severity.toUpperCase()} FAULT] ${input.description}`);
    }

    db.prepare(`
      INSERT INTO vehicle_faults (
        id, vehicle_id, driver_id, reported_by_user_id, category, description, severity, odometer, photo_urls, status, maintenance_id
      ) VALUES (
        @id, @vehicleId, @driverId, @userId, @category, @description, @severity, @odometer, @photoUrls, 'open', @maintenanceId
      )
    `).run({
      id,
      vehicleId: assigned.id,
      driverId,
      userId,
      category: input.category,
      description: input.description,
      severity: input.severity,
      odometer: input.odometer ?? null,
      photoUrls: JSON.stringify(input.photoUrls ?? []),
      maintenanceId,
    });

    if (input.severity === "critical") {
      flagVehicleUnderRepair(assigned.id);
      createAlert("critical", "vehicle", assigned.id, "vehicle_fault",
        `Critical fault reported for vehicle ${assigned.vehicle_number}: ${input.description}`);
    } else if (input.severity === "major") {
      createAlert("warning", "vehicle", assigned.id, "vehicle_fault",
        `Major fault reported for vehicle ${assigned.vehicle_number}: ${input.description}`);
    }

    auditDriverAction(req, "DRIVER_FAULT_REPORTED", "vehicle_faults", id, { ...input, vehicleId: assigned.id, maintenanceId });
    res.status(201).json({ data: db.prepare("SELECT * FROM vehicle_faults WHERE id = ?").get(id) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Incidents                                                           */
/* ------------------------------------------------------------------ */

router.get("/incidents", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const rows = db.prepare(`
      SELECT ir.*, v.vehicle_number
      FROM incident_reports ir
      LEFT JOIN vehicles v ON v.id = ir.vehicle_id
      WHERE ir.driver_id = ?
      ORDER BY ir.created_at DESC
    `).all(driverId) as any[];
    res.json({ data: rows });
  } catch (e) { next(e); }
});

const incidentSchema = z.object({
  incidentType: z.enum(["accident", "incident", "near_miss", "damage", "theft", "other"]),
  incidentDate: z.string().min(1),
  location: z.string().optional(),
  description: z.string().min(3),
  injuries: z.boolean().default(false),
  injuryDetails: z.string().optional(),
  damageDescription: z.string().optional(),
  thirdPartyDetails: z.string().optional(),
  photoUrls: z.array(z.string()).optional(),
  documentUrls: z.array(z.string()).optional(),
});

router.post("/incidents", (req, res, next) => {
  try {
    const { driverId, userId } = requireDriverContext(req);
    const input = incidentSchema.parse(req.body);
    const assigned = getAssignedVehicle(driverId);

    const id = uuid();
    db.prepare(`
      INSERT INTO incident_reports (
        id, vehicle_id, driver_id, reported_by_user_id, incident_type, incident_date, location,
        description, injuries, injury_details, damage_description, third_party_details,
        photo_urls, document_urls, status
      ) VALUES (
        @id, @vehicleId, @driverId, @userId, @incidentType, @incidentDate, @location,
        @description, @injuries, @injuryDetails, @damageDescription, @thirdPartyDetails,
        @photoUrls, @documentUrls, 'submitted'
      )
    `).run({
      id,
      vehicleId: assigned?.id ?? null,
      driverId,
      userId,
      incidentType: input.incidentType,
      incidentDate: input.incidentDate,
      location: input.location ?? null,
      description: input.description,
      injuries: input.injuries ? 1 : 0,
      injuryDetails: input.injuryDetails ?? null,
      damageDescription: input.damageDescription ?? null,
      thirdPartyDetails: input.thirdPartyDetails ?? null,
      photoUrls: JSON.stringify(input.photoUrls ?? []),
      documentUrls: JSON.stringify(input.documentUrls ?? []),
    });

    // Admin notification / alert on submit.
    const severity = input.injuries || input.incidentType === "accident" ? "critical" : "warning";
    createAlert(severity, "vehicle", assigned?.id ?? null, "driver_incident_report",
      `${input.incidentType.toUpperCase()} report${assigned ? ` for vehicle ${assigned.vehicle_number}` : ""} on ${input.incidentDate}${input.injuries ? " (injuries reported)" : ""}: ${input.description}`);

    const admins = db.prepare(`
      SELECT u.id FROM users u JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'admin' AND u.status = 'active'
    `).all() as { id: string }[];
    for (const admin of admins) {
      createNotification({
        userId: admin.id,
        title: `New ${input.incidentType} report`,
        body: `${input.description}`.slice(0, 240),
        category: "incident",
        relatedEntity: "incident_reports",
        relatedId: id,
        createdBy: userId,
      });
    }

    auditDriverAction(req, "DRIVER_INCIDENT_REPORTED", "incident_reports", id, { ...input, vehicleId: assigned?.id ?? null });
    res.status(201).json({ data: db.prepare("SELECT * FROM incident_reports WHERE id = ?").get(id) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Maintenance requests                                                */
/* ------------------------------------------------------------------ */

router.get("/maintenance-requests", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const rows = db.prepare(`
      SELECT vm.*, v.vehicle_number
      FROM vehicle_maintenance vm
      JOIN vehicles v ON v.id = vm.vehicle_id
      WHERE vm.driver_id = ?
      ORDER BY vm.created_at DESC
    `).all(driverId) as any[];
    res.json({ data: rows });
  } catch (e) { next(e); }
});

const maintenanceRequestSchema = z.object({
  description: z.string().min(3),
  maintenanceType: z.enum(["scheduled_service", "unscheduled_repair", "inspection_fix", "other"]).default("unscheduled_repair"),
  preferredDate: z.string().optional(),
});

router.post("/maintenance-requests", (req, res, next) => {
  try {
    const { driverId, userId } = requireDriverContext(req);
    const input = maintenanceRequestSchema.parse(req.body);

    const assigned = getAssignedVehicle(driverId);
    if (!assigned) throw new ApiError(400, "No vehicle is currently assigned to you");

    const id = uuid();
    db.prepare(`
      INSERT INTO vehicle_maintenance (
        id, vehicle_id, driver_id, requested_by, maintenance_type, description, scheduled_date, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')
    `).run(id, assigned.id, driverId, userId, input.maintenanceType, input.description, input.preferredDate ?? null);

    createAlert("warning", "vehicle", assigned.id, "maintenance_request",
      `Maintenance request for vehicle ${assigned.vehicle_number}: ${input.description}`);

    auditDriverAction(req, "DRIVER_MAINTENANCE_REQUESTED", "vehicle_maintenance", id, { ...input, vehicleId: assigned.id });
    res.status(201).json({ data: db.prepare("SELECT * FROM vehicle_maintenance WHERE id = ?").get(id) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Safety                                                              */
/* ------------------------------------------------------------------ */

router.get("/safety", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const safety = computeSafety(driverId);
    const events = db.prepare(`
      SELECT * FROM driver_events WHERE driver_id = ? ORDER BY recorded_at DESC LIMIT 50
    `).all(driverId) as any[];
    const exceptions = db.prepare(`
      SELECT COUNT(*) AS count FROM fleet_exceptions WHERE driver_id = ? AND status IN ('open', 'investigating')
    `).get(driverId) as { count: number };

    res.json({
      data: {
        ...safety,
        openExceptions: exceptions.count,
        recentEvents: events,
      },
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Leave                                                               */
/* ------------------------------------------------------------------ */

router.get("/leave", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const rows = db.prepare("SELECT * FROM driver_leave_requests WHERE driver_id = ? ORDER BY created_at DESC").all(driverId);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

const leaveSchema = z.object({
  leaveType: z.enum(["annual", "sick", "compassionate", "unpaid", "other"]),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  reason: z.string().optional(),
}).refine((v) => v.endDate >= v.startDate, { message: "End date must be on or after the start date", path: ["endDate"] });

router.post("/leave", (req, res, next) => {
  try {
    const { driverId, userId } = requireDriverContext(req);
    const input = leaveSchema.parse(req.body);
    const id = uuid();
    db.prepare(`
      INSERT INTO driver_leave_requests (id, driver_id, user_id, leave_type, start_date, end_date, reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, driverId, userId, input.leaveType, input.startDate, input.endDate, input.reason ?? null);

    auditDriverAction(req, "DRIVER_LEAVE_REQUESTED", "driver_leave_requests", id, input);
    res.status(201).json({ data: db.prepare("SELECT * FROM driver_leave_requests WHERE id = ?").get(id) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

router.get("/documents", (req, res, next) => {
  try {
    const { driverId } = requireDriverContext(req);
    const docs = db.prepare("SELECT * FROM driver_documents WHERE driver_id = ? ORDER BY created_at DESC").all(driverId) as any[];
    const driver = getDriver(driverId);
    res.json({
      data: docs,
      licence: driver
        ? { licenceNumber: driver.licence_number, licenceClass: driver.licence_class, licenceExpiry: driver.licence_expiry }
        : null,
    });
  } catch (e) { next(e); }
});

const documentSchema = z.object({
  documentType: z.enum(["licence", "permit", "medical", "certification", "insurance", "other"]),
  title: z.string().min(1),
  fileUrl: z.string().min(1),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  expiryDate: z.string().optional(),
});

router.post("/documents", (req, res, next) => {
  try {
    const { driverId, userId } = requireDriverContext(req);
    const input = documentSchema.parse(req.body);
    const id = uuid();
    db.prepare(`
      INSERT INTO driver_documents (id, driver_id, user_id, document_type, title, file_url, file_name, mime_type, expiry_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, driverId, userId, input.documentType, input.title, input.fileUrl, input.fileName ?? null, input.mimeType ?? null, input.expiryDate ?? null);

    auditDriverAction(req, "DRIVER_DOCUMENT_UPLOADED", "driver_documents", id, input);
    res.status(201).json({ data: db.prepare("SELECT * FROM driver_documents WHERE id = ?").get(id) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

router.get("/notifications", (req, res, next) => {
  try {
    requireDriverContext(req);
    const rows = db.prepare("SELECT * FROM driver_notifications WHERE user_id = ? ORDER BY created_at DESC").all(req.user!.id) as any[];
    res.json({ data: rows, unreadCount: rows.filter((r) => r.is_read === 0).length });
  } catch (e) { next(e); }
});

router.post("/notifications/:id/read", (req, res, next) => {
  try {
    requireDriverContext(req);
    const existing = db.prepare("SELECT * FROM driver_notifications WHERE id = ? AND user_id = ?").get(req.params.id, req.user!.id);
    if (!existing) throw new ApiError(404, "Notification not found");
    db.prepare("UPDATE driver_notifications SET is_read = 1, read_at = datetime('now') WHERE id = ? AND user_id = ?").run(req.params.id, req.user!.id);
    auditDriverAction(req, "DRIVER_NOTIFICATION_READ", "driver_notifications", req.params.id);
    res.json({ data: db.prepare("SELECT * FROM driver_notifications WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* File uploads                                                        */
/* ------------------------------------------------------------------ */

router.post("/uploads", uploadFilesMiddleware, (req: Request, res: Response, next: NextFunction) => {
  try {
    requireDriverContext(req);
    const files = collectFileInfos(req.files);
    if (files.length === 0) throw new ApiError(400, "No files uploaded");
    auditDriverAction(req, "DRIVER_FILE_UPLOADED", "uploads", null, { count: files.length, files: files.map((f) => f.url) });
    res.status(201).json({ data: files });
  } catch (e) { next(e); }
});

export default router;
