import { Router } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { resolveClientScopes } from "../utils/scope";
import { buildFleetIntelligence } from "../services/fleetIntelligence";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/v1/fleet/insights
 * Ranked, explainable fleet health recommendations.
 */
router.get("/insights", (req, res, next) => {
  try {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 12;
    res.json({ data: buildFleetIntelligence({ scopes: resolveClientScopes(req.user), limit }) });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/fleet/overview — Fleet Dashboard Overview Metrics. */
router.get("/overview", (req, res, next) => {
  try {
    const scopes = resolveClientScopes(req.user);
    const scope = scopes && scopes.length > 0
      ? { sql: ` AND v.client_id IN (${scopes.map(() => "?").join(", ")})`, params: scopes as unknown[] }
      : { sql: "", params: [] as unknown[] };

    const totalVehicles = (db.prepare(`SELECT COUNT(*) as count FROM vehicles v WHERE v.status != 'disposed'${scope.sql}`).get(...scope.params) as any).count;

    // Status breakdown from vehicle_status_view
    const statusRows = db.prepare(`
      SELECT vsv.computed_status, COUNT(*) as count
      FROM vehicle_status_view vsv
      JOIN vehicles v ON v.id = vsv.vehicle_id
      WHERE v.status != 'disposed'${scope.sql}
      GROUP BY vsv.computed_status
    `).all(...scope.params) as { computed_status: string; count: number }[];

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

    // PGT is the operating timezone (UTC+10); "today" must match operator reports.
    const distanceTodayRow = db.prepare(`
      SELECT COALESCE(SUM(vt.total_km), 0) as total
      FROM vehicle_trips vt
      JOIN vehicles v ON v.id = vt.vehicle_id
      WHERE vt.date = date('now', '+10 hours')${scope.sql}
    `).get(...scope.params) as any;

    // Fuel consumed & cost today
    const fuelTodayRow = db.prepare(`
      SELECT COALESCE(SUM(fl.litres), 0) as total_litres, COALESCE(SUM(fl.total_cost), 0) as total_cost
      FROM vehicle_fuel_logs fl
      JOIN vehicles v ON v.id = fl.vehicle_id
      WHERE fl.date = date('now', '+10 hours')${scope.sql}
    `).get(...scope.params) as any;

    // Utilisation %
    const operatingVehicles = statusCounts.moving + statusCounts.idle + statusCounts.stationary;
    const utilisationPct = totalVehicles > 0 ? Number(((operatingVehicles / totalVehicles) * 100).toFixed(1)) : 0;

    // Open exceptions count & breakdown by severity
    const openExceptionsRow = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN fe.severity = 'critical' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN fe.severity = 'warning' THEN 1 ELSE 0 END) as warning,
        SUM(CASE WHEN fe.severity = 'info' THEN 1 ELSE 0 END) as info
      FROM fleet_exceptions fe
      LEFT JOIN vehicles v ON v.id = fe.vehicle_id
      WHERE fe.status IN ('open', 'investigating')${scope.sql}
    `).get(...scope.params) as any;

    // Exceptions by category
    const exceptionsByCategory = db.prepare(`
      SELECT fe.category, COUNT(*) as count
      FROM fleet_exceptions fe
      LEFT JOIN vehicles v ON v.id = fe.vehicle_id
      WHERE fe.status IN ('open', 'investigating')${scope.sql}
      GROUP BY fe.category
    `).all(...scope.params);

    // Recent exception alerts
    const recentExceptions = db.prepare(`
      SELECT fe.*, v.vehicle_number, d.name as driver_name
      FROM fleet_exceptions fe
      LEFT JOIN vehicles v ON v.id = fe.vehicle_id
      LEFT JOIN drivers d ON d.id = fe.driver_id
      WHERE fe.status IN ('open', 'investigating')${scope.sql}
      ORDER BY fe.created_at DESC
      LIMIT 5
    `).all(...scope.params);

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
