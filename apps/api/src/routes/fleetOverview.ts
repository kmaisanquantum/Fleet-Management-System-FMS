import { Router } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/v1/fleet/overview
 * Fleet Dashboard Overview Metrics
 */
router.get("/overview", (_req, res, next) => {
  try {
    const totalVehicles = (db.prepare("SELECT COUNT(*) as count FROM vehicles WHERE status != 'disposed'").get() as any).count;

    // Status breakdown from vehicle_status_view
    const statusRows = db.prepare(`
      SELECT computed_status, COUNT(*) as count
      FROM vehicle_status_view
      GROUP BY computed_status
    `).all() as { computed_status: string; count: number }[];

    const statusCounts: Record<string, number> = {
      moving: 0,
      stationary: 0,
      idle: 0,
      offline: 0,
      under_maintenance: 0,
      unassigned: 0,
    };
    for (const r of statusRows) {
      if (r.computed_status in statusCounts) {
        statusCounts[r.computed_status] = r.count;
      }
    }

    // Distance today from trips or GPS telemetry
    const distanceTodayRow = db.prepare(`
      SELECT COALESCE(SUM(total_km), 0) as total
      FROM vehicle_trips
      WHERE date = date('now')
    `).get() as any;

    // Fuel consumed & cost today
    const fuelTodayRow = db.prepare(`
      SELECT COALESCE(SUM(litres), 0) as total_litres, COALESCE(SUM(total_cost), 0) as total_cost
      FROM vehicle_fuel_logs
      WHERE date = date('now') OR date >= date('now', '-1 day')
    `).get() as any;

    // Utilisation %
    const operatingVehicles = statusCounts.moving + statusCounts.idle + statusCounts.stationary;
    const utilisationPct = totalVehicles > 0 ? Number(((operatingVehicles / totalVehicles) * 100).toFixed(1)) : 0;

    // Open exceptions count & breakdown by severity
    const openExceptionsRow = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warning,
        SUM(CASE WHEN severity = 'info' THEN 1 ELSE 0 END) as info
      FROM fleet_exceptions
      WHERE status IN ('open', 'investigating')
    `).get() as any;

    // Exceptions by category
    const exceptionsByCategory = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM fleet_exceptions
      WHERE status IN ('open', 'investigating')
      GROUP BY category
    `).all();

    // Recent exception alerts
    const recentExceptions = db.prepare(`
      SELECT fe.*, v.vehicle_number, d.name as driver_name
      FROM fleet_exceptions fe
      LEFT JOIN vehicles v ON v.id = fe.vehicle_id
      LEFT JOIN drivers d ON d.id = fe.driver_id
      WHERE fe.status IN ('open', 'investigating')
      ORDER BY fe.created_at DESC
      LIMIT 5
    `).all();

    res.json({
      data: {
        totalVehicles,
        statusCounts,
        distanceTodayKm: Number(distanceTodayRow.total.toFixed(1)),
        fuelConsumedTodayLitres: Number(fuelTodayRow.total_litres.toFixed(1)),
        fuelCostTodayAmount: Number(fuelTodayRow.total_cost.toFixed(2)),
        utilisationPct,
        exceptions: {
          totalOpen: openExceptionsRow.total || 0,
          critical: openExceptionsRow.critical || 0,
          warning: openExceptionsRow.warning || 0,
          info: openExceptionsRow.info || 0,
          byCategory: exceptionsByCategory,
          recent: recentExceptions,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
