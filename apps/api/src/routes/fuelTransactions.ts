import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { writeAudit } from "../utils/audit";
import { reconcileTransaction, createFleetExceptionsForTransaction } from "../services/reconciliation";

const router = Router();
router.use(requireAuth);

const FLEET_WRITE_ROLES = ["admin", "fleet_admin", "fleet_manager", "driver", "finance", "fuel_operator"];

router.get("/cards", (_req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT fc.*, v.vehicle_number, v.registration_number, d.name as driver_name
      FROM fuel_cards fc
      LEFT JOIN vehicles v ON v.id = fc.vehicle_id
      LEFT JOIN drivers d ON d.id = fc.authorised_driver_id
      ORDER BY fc.card_number ASC
    `).all();
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

router.get("/stations", (_req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM fuel_stations
      ORDER BY name ASC
    `).all();
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

router.get("/", (req, res, next) => {
  try {
    const { vehicleId, reconciliationStatus, source, startDate, endDate } = req.query;
    let query = `
      SELECT
        fl.*,
        v.vehicle_number,
        v.registration_number,
        d.name as driver_name,
        fc.card_number,
        fs.name as station_name,
        fs.station_type
      FROM vehicle_fuel_logs fl
      JOIN vehicles v ON v.id = fl.vehicle_id
      LEFT JOIN drivers d ON d.id = fl.driver_id
      LEFT JOIN fuel_cards fc ON fc.id = fl.fuel_card_id
      LEFT JOIN fuel_stations fs ON fs.id = fl.station_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (vehicleId) {
      query += " AND fl.vehicle_id = ?";
      params.push(vehicleId);
    }
    if (reconciliationStatus) {
      query += " AND fl.reconciliation_status = ?";
      params.push(reconciliationStatus);
    }
    if (source) {
      query += " AND fl.source = ?";
      params.push(source);
    }
    if (startDate) {
      query += " AND fl.date >= ?";
      params.push(startDate);
    }
    if (endDate) {
      query += " AND fl.date <= ?";
      params.push(endDate);
    }

    query += " ORDER BY fl.date DESC, fl.created_at DESC";
    const rows = db.prepare(query).all(...params);
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", (req, res, next) => {
  try {
    const row = db.prepare(`
      SELECT
        fl.*,
        v.vehicle_number,
        v.registration_number,
        v.make,
        v.model,
        d.name as driver_name,
        fc.card_number,
        fs.name as station_name,
        fs.lat as station_lat,
        fs.lon as station_lon
      FROM vehicle_fuel_logs fl
      JOIN vehicles v ON v.id = fl.vehicle_id
      LEFT JOIN drivers d ON d.id = fl.driver_id
      LEFT JOIN fuel_cards fc ON fc.id = fl.fuel_card_id
      LEFT JOIN fuel_stations fs ON fs.id = fl.station_id
      WHERE fl.id = ?
    `).get(req.params.id) as any;

    if (!row) {
      return res.status(404).json({ error: "Fuel transaction not found" });
    }

    const exceptions = db.prepare(`
      SELECT * FROM fleet_exceptions WHERE transaction_id = ?
    `).all(req.params.id);

    res.json({ data: { ...row, exceptions } });
  } catch (e) {
    next(e);
  }
});

const fuelTransactionSchema = z.object({
  vehicleId: z.string().min(1),
  driverId: z.string().optional(),
  fuelCardId: z.string().optional(),
  stationId: z.string().optional(),
  station: z.string().optional(),
  date: z.string().min(1),
  time: z.string().optional(),
  fuelType: z.string().min(1),
  litres: z.number().positive(),
  costPerLitre: z.number().positive(),
  odometerReading: z.number().positive(),
  paymentMethod: z.string().optional(),
  receiptRef: z.string().optional(),
  source: z.enum(["card", "depot", "manual"]).default("manual"),
});

router.post("/", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const input = fuelTransactionSchema.parse(req.body);
    const totalCost = Number((input.litres * input.costPerLitre).toFixed(2));

    // Previous odometer for efficiency metrics
    const prevLog = db.prepare(`
      SELECT odometer_reading FROM vehicle_fuel_logs
      WHERE vehicle_id = ? AND odometer_reading < ?
      ORDER BY odometer_reading DESC LIMIT 1
    `).get(input.vehicleId, input.odometerReading) as { odometer_reading: number } | undefined;

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

    // Run reconciliation rules engine
    const reconResult = reconcileTransaction({
      id,
      vehicle_id: input.vehicleId,
      driver_id: input.driverId,
      fuel_card_id: input.fuelCardId,
      station_id: input.stationId,
      station: input.station,
      date: input.date,
      time: input.time,
      fuel_type: input.fuelType,
      litres: input.litres,
      cost_per_litre: input.costPerLitre,
      total_cost: totalCost,
      odometer_reading: input.odometerReading,
      payment_method: input.paymentMethod,
      receipt_ref: input.receiptRef,
      source: input.source,
    });

    const reconciliationStatus = reconResult.status;
    const gpsVerified = reconResult.gps_verified ? 1 : 0;

    db.prepare(`
      INSERT INTO vehicle_fuel_logs (
        id, vehicle_id, driver_id, date, time, station, fuel_type, litres,
        cost_per_litre, total_cost, odometer_reading, payment_method, receipt_ref,
        l_per_100km, km_per_l, cost_per_km, fuel_card_id, station_id, source,
        gps_verified, reconciliation_status
      ) VALUES (
        @id, @vehicleId, @driverId, @date, @time, @station, @fuelType, @litres,
        @costPerLitre, @totalCost, @odometerReading, @paymentMethod, @receiptRef,
        @lPer100km, @kmPerL, @costPerKm, @fuelCardId, @stationId, @source,
        @gpsVerified, @reconciliationStatus
      )
    `).run({
      id,
      vehicleId: input.vehicleId,
      driverId: input.driverId ?? null,
      date: input.date,
      time: input.time ?? null,
      station: input.station ?? null,
      fuelType: input.fuelType,
      litres: input.litres,
      costPerLitre: input.costPerLitre,
      totalCost,
      odometerReading: input.odometerReading,
      paymentMethod: input.paymentMethod ?? null,
      receiptRef: input.receiptRef ?? null,
      lPer100km,
      kmPerL,
      costPerKm,
      fuelCardId: input.fuelCardId ?? null,
      stationId: input.stationId ?? null,
      source: input.source,
      gpsVerified,
      reconciliationStatus,
    });

    // If violations were found, generate fleet exceptions
    if (reconResult.violations.length > 0) {
      createFleetExceptionsForTransaction(id, { ...input, total_cost: totalCost, cost_per_litre: input.costPerLitre, odometer_reading: input.odometerReading, fuel_type: input.fuelType, vehicle_id: input.vehicleId }, reconResult.violations);
    }

    // Update vehicle odometer if higher
    db.prepare(`
      UPDATE vehicles
      SET current_odometer = MAX(current_odometer, ?)
      WHERE id = ?
    `).run(input.odometerReading, input.vehicleId);

    writeAudit({
      userId: req.user!.id,
      action: "FUEL_TRANSACTION_RECORDED",
      entity: "vehicle_fuel_logs",
      entityId: id,
      newValue: { ...input, totalCost, reconciliationStatus, violationsCount: reconResult.violations.length },
    });

    const created = db.prepare("SELECT * FROM vehicle_fuel_logs WHERE id = ?").get(id);
    res.status(201).json({
      data: created,
      reconciliation: reconResult,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
