import { Router } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/v1/fleet/utilisation
 * Multi-dimensional Fleet Utilisation Analytics
 */
router.get("/utilisation", (req, res, next) => {
  try {
    const { startDate, endDate, department, vehicleId, driverId, location, type } = req.query;

    let tripQuery = `
      SELECT
        vt.*,
        v.vehicle_number,
        v.vehicle_type,
        v.department as vehicle_dept,
        v.location as vehicle_location,
        d.name as driver_name
      FROM vehicle_trips vt
      JOIN vehicles v ON v.id = vt.vehicle_id
      LEFT JOIN drivers d ON d.id = vt.driver_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (startDate) {
      tripQuery += " AND vt.date >= ?";
      params.push(startDate);
    }
    if (endDate) {
      tripQuery += " AND vt.date <= ?";
      params.push(endDate);
    }
    if (department) {
      tripQuery += " AND v.department = ?";
      params.push(department);
    }
    if (vehicleId) {
      tripQuery += " AND vt.vehicle_id = ?";
      params.push(vehicleId);
    }
    if (driverId) {
      tripQuery += " AND vt.driver_id = ?";
      params.push(driverId);
    }
    if (location) {
      tripQuery += " AND v.location = ?";
      params.push(location);
    }
    if (type) {
      tripQuery += " AND v.vehicle_type = ?";
      params.push(type);
    }

    const trips = db.prepare(tripQuery).all(...params) as any[];

    // Aggregate overall metrics
    const totalTrips = trips.length;
    const totalDistanceKm = trips.reduce((acc, t) => acc + (t.total_km || 0), 0);

    // Department breakdown
    const deptMap: Record<string, { trips: number; distance: number }> = {};
    for (const t of trips) {
      const dept = t.vehicle_dept || "Unassigned";
      if (!deptMap[dept]) deptMap[dept] = { trips: 0, distance: 0 };
      deptMap[dept].trips += 1;
      deptMap[dept].distance += t.total_km || 0;
    }
    const byDepartment = Object.keys(deptMap).map((dept) => ({
      department: dept,
      tripsCount: deptMap[dept].trips,
      distanceKm: Number(deptMap[dept].distance.toFixed(1)),
    }));

    // Vehicle Type breakdown
    const typeMap: Record<string, { trips: number; distance: number }> = {};
    for (const t of trips) {
      const vType = t.vehicle_type || "Other";
      if (!typeMap[vType]) typeMap[vType] = { trips: 0, distance: 0 };
      typeMap[vType].trips += 1;
      typeMap[vType].distance += t.total_km || 0;
    }
    const byVehicleType = Object.keys(typeMap).map((vType) => ({
      vehicleType: vType,
      tripsCount: typeMap[vType].trips,
      distanceKm: Number(typeMap[vType].distance.toFixed(1)),
    }));

    // Vehicle utilization details
    let vehiclesQuery = "SELECT id, vehicle_number, registration_number, department, vehicle_type, current_odometer FROM vehicles WHERE status != 'disposed'";
    const vParams: any[] = [];
    if (department) {
      vehiclesQuery += " AND department = ?";
      vParams.push(department);
    }
    if (type) {
      vehiclesQuery += " AND vehicle_type = ?";
      vParams.push(type);
    }
    const vehiclesList = db.prepare(vehiclesQuery).all(...vParams) as any[];

    const vehicleUtilisation = vehiclesList.map((v) => {
      const vTrips = trips.filter((t) => t.vehicle_id === v.id);
      const dist = vTrips.reduce((acc, t) => acc + (t.total_km || 0), 0);
      return {
        vehicleId: v.id,
        vehicleNumber: v.vehicle_number,
        registrationNumber: v.registration_number,
        department: v.department,
        vehicleType: v.vehicle_type,
        currentOdometer: v.current_odometer,
        tripsCount: vTrips.length,
        distanceKm: Number(dist.toFixed(1)),
      };
    }).sort((a, b) => b.distanceKm - a.distanceKm);

    res.json({
      data: {
        summary: {
          totalTrips,
          totalDistanceKm: Number(totalDistanceKm.toFixed(1)),
          activeVehiclesCount: vehicleUtilisation.filter((v) => v.tripsCount > 0).length,
          totalVehiclesCount: vehiclesList.length,
        },
        byDepartment,
        byVehicleType,
        vehicleUtilisation,
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
