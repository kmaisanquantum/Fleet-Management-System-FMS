import { Router } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

/**
 * Optional analytics tables (e.g. fleet_exceptions, driver_events) may be
 * absent on databases that were created before the table existed and have not
 * been re-initialised (run `npm run seed` on dev / re-run initSchema).
 * Degrade gracefully for a missing table instead of 500-ing the whole
 * endpoint, while still surfacing genuine query errors.
 */
function isMissingTableError(e: unknown): boolean {
  return e instanceof Error && /no such table/i.test(e.message);
}

function safeAll<T = any>(sql: string, ...params: any[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch (e) {
    if (isMissingTableError(e)) return [];
    throw e;
  }
}

function safeGet<T = any>(sql: string, ...params: any[]): T | undefined {
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } catch (e) {
    if (isMissingTableError(e)) return undefined;
    throw e;
  }
}

/**
 * GET /api/v1/driver-intelligence
 * Driver Performance, Safety Scores, and Event Analytics
 */
router.get("/", (req, res, next) => {
  try {
    const { department } = req.query;
    let query = `
      SELECT
        d.*,
        v.vehicle_number as assigned_vehicle_number,
        v.registration_number as assigned_vehicle_reg
      FROM drivers d
      LEFT JOIN vehicle_allocations va ON va.driver_id = d.id AND va.authorisation_status = 'active'
      LEFT JOIN vehicles v ON v.id = va.vehicle_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (department) {
      query += " AND d.department = ?";
      params.push(department);
    }
    query += " ORDER BY d.name ASC";
    const drivers = db.prepare(query).all(...params) as any[];

    // Calculate metrics for each driver
    const driverProfiles = drivers.map((driver) => {
      // Driver safety events
      const events = safeAll(`
        SELECT * FROM driver_events
        WHERE driver_id = ?
        ORDER BY recorded_at DESC
      `, driver.id) as any[];

      const speedingCount = events.filter((e) => e.event_type === "speeding").length;
      const harshBrakingCount = events.filter((e) => e.event_type === "harsh_braking").length;
      const harshAccelCount = events.filter((e) => e.event_type === "harsh_accel").length;
      const idlingCount = events.filter((e) => e.event_type === "excessive_idling").length;

      // Deduct points from 100 base score
      const safetyPenalty = speedingCount * 10 + harshBrakingCount * 5 + harshAccelCount * 5 + idlingCount * 3;
      const safetyScore = Math.max(0, 100 - safetyPenalty);

      let riskRating: "low" | "medium" | "high" = "low";
      if (safetyScore < 60) riskRating = "high";
      else if (safetyScore < 80) riskRating = "medium";

      // Fuel efficiency & fuel logs
      const fuelStats = (safeGet(`
        SELECT
          COUNT(*) as total_refuels,
          COALESCE(AVG(km_per_l), 0) as avg_km_per_l,
          COALESCE(SUM(total_cost), 0) as total_fuel_cost
        FROM vehicle_fuel_logs
        WHERE driver_id = ?
      `, driver.id) as any) ?? { total_refuels: 0, avg_km_per_l: 0, total_fuel_cost: 0 };

      // Linked exceptions
      const exceptionsCount = Number((safeGet(`
        SELECT COUNT(*) as count FROM fleet_exceptions WHERE driver_id = ? AND status IN ('open', 'investigating')
      `, driver.id) as any)?.count ?? 0);

      return {
        id: driver.id,
        employeeNumber: driver.employee_number,
        name: driver.name,
        department: driver.department,
        licenceNumber: driver.licence_number,
        licenceClass: driver.licence_class,
        licenceExpiry: driver.licence_expiry,
        authorisationStatus: driver.authorisation_status,
        assignedVehicle: driver.assigned_vehicle_number ? `${driver.assigned_vehicle_number} (${driver.assigned_vehicle_reg})` : "Unassigned",
        metrics: {
          safetyScore,
          riskRating,
          speedingCount,
          harshBrakingCount,
          harshAccelCount,
          idlingCount,
          avgKmL: Number(fuelStats.avg_km_per_l.toFixed(1)),
          totalFuelCost: Number(fuelStats.total_fuel_cost.toFixed(2)),
          openExceptionsCount: exceptionsCount,
        },
        recentEvents: events.slice(0, 5),
      };
    });

    // Summary rankings
    const sortedBySafety = [...driverProfiles].sort((a, b) => b.metrics.safetyScore - a.metrics.safetyScore);

    res.json({
      data: driverProfiles,
      summary: {
        totalDrivers: driverProfiles.length,
        highRiskCount: driverProfiles.filter((d) => d.metrics.riskRating === "high").length,
        avgFleetSafetyScore: driverProfiles.length > 0 ? Number((driverProfiles.reduce((acc, d) => acc + d.metrics.safetyScore, 0) / driverProfiles.length).toFixed(1)) : 100,
        topPerformers: sortedBySafety.slice(0, 3),
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
