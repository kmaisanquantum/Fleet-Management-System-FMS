import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { writeAudit } from "../utils/audit";

const router = Router();
router.use(requireAuth);

const FLEET_WRITE_ROLES = ["admin", "fleet_admin", "fleet_manager", "finance"];

/**
 * GET /api/v1/exceptions
 * List fleet exceptions with filters
 */
router.get("/", (req, res, next) => {
  try {
    const { severity, category, status, vehicleId, driverId } = req.query;
    let query = `
      SELECT
        fe.*,
        v.vehicle_number,
        v.registration_number,
        v.make,
        v.model,
        d.name as driver_name,
        d.employee_number,
        fl.litres as txn_litres,
        fl.total_cost as txn_cost,
        fl.station as txn_station
      FROM fleet_exceptions fe
      LEFT JOIN vehicles v ON v.id = fe.vehicle_id
      LEFT JOIN drivers d ON d.id = fe.driver_id
      LEFT JOIN vehicle_fuel_logs fl ON fl.id = fe.transaction_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (severity) {
      query += " AND fe.severity = ?";
      params.push(severity);
    }
    if (category) {
      query += " AND fe.category = ?";
      params.push(category);
    }
    if (status) {
      query += " AND fe.status = ?";
      params.push(status);
    }
    if (vehicleId) {
      query += " AND fe.vehicle_id = ?";
      params.push(vehicleId);
    }
    if (driverId) {
      query += " AND fe.driver_id = ?";
      params.push(driverId);
    }

    query += " ORDER BY CASE fe.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, fe.created_at DESC";
    const rows = db.prepare(query).all(...params);

    // Summary counts
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN severity = 'critical' AND status IN ('open', 'investigating') THEN 1 ELSE 0 END) as critical_open,
        SUM(CASE WHEN severity = 'warning' AND status IN ('open', 'investigating') THEN 1 ELSE 0 END) as warning_open,
        SUM(CASE WHEN severity = 'info' AND status IN ('open', 'investigating') THEN 1 ELSE 0 END) as info_open,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN status = 'investigating' THEN 1 ELSE 0 END) as investigating_count,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_count,
        SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) as dismissed_count
      FROM fleet_exceptions
    `).get();

    res.json({ data: rows, summary });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/exceptions/:id
 * Detailed exception record with supporting transaction + GPS + vehicle data
 */
router.get("/:id", (req, res, next) => {
  try {
    const exc = db.prepare(`
      SELECT
        fe.*,
        v.vehicle_number,
        v.registration_number,
        v.make,
        v.model,
        v.tank_capacity_litres,
        v.expected_km_per_l,
        d.name as driver_name,
        d.employee_number,
        d.licence_number
      FROM fleet_exceptions fe
      LEFT JOIN vehicles v ON v.id = fe.vehicle_id
      LEFT JOIN drivers d ON d.id = fe.driver_id
      WHERE fe.id = ?
    `).get(req.params.id) as any;

    if (!exc) {
      return res.status(404).json({ error: "Exception record not found" });
    }

    let transaction: any = null;
    if (exc.transaction_id) {
      transaction = db.prepare(`
        SELECT fl.*, fc.card_number, fs.name as station_name, fs.lat as station_lat, fs.lon as station_lon
        FROM vehicle_fuel_logs fl
        LEFT JOIN fuel_cards fc ON fc.id = fl.fuel_card_id
        LEFT JOIN fuel_stations fs ON fs.id = fl.station_id
        WHERE fl.id = ?
      `).get(exc.transaction_id);
    }

    let gpsPosition: any = null;
    if (exc.gps_position_id) {
      gpsPosition = db.prepare("SELECT * FROM gps_positions WHERE id = ?").get(exc.gps_position_id);
    }

    res.json({
      data: {
        ...exc,
        supportingData: {
          transaction,
          gpsPosition,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

const updateExceptionSchema = z.object({
  status: z.enum(["open", "investigating", "resolved", "dismissed"]),
  notes: z.string().optional(),
  resolution: z.string().optional(),
});

/**
 * PATCH /api/v1/exceptions/:id
 * Update status, notes, or resolution of an exception
 */
router.patch("/:id", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM fleet_exceptions WHERE id = ?").get(req.params.id) as any;
    if (!existing) {
      return res.status(404).json({ error: "Exception record not found" });
    }

    const input = updateExceptionSchema.parse(req.body);
    const resolvedAt = input.status === "resolved" || input.status === "dismissed" ? new Date().toISOString() : null;

    db.prepare(`
      UPDATE fleet_exceptions
      SET status = ?, notes = COALESCE(?, notes), resolution = COALESCE(?, resolution), resolved_at = COALESCE(?, resolved_at)
      WHERE id = ?
    `).run(input.status, input.notes ?? null, input.resolution ?? null, resolvedAt, req.params.id);

    writeAudit({
      userId: req.user!.id,
      action: "FLEET_EXCEPTION_UPDATED",
      entity: "fleet_exceptions",
      entityId: req.params.id,
      previousValue: existing,
      newValue: { ...input, resolvedAt },
    });

    const updated = db.prepare("SELECT * FROM fleet_exceptions WHERE id = ?").get(req.params.id);
    res.json({ data: updated });
  } catch (e) {
    next(e);
  }
});

export default router;
