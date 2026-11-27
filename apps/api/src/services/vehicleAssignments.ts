import { v4 as uuid } from "uuid";
import { db } from "../db";
import { ApiError } from "../middleware/errorHandler";
import { writeAudit } from "../utils/audit";

export class AssignmentError extends ApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "AssignmentError";
  }
}

export interface ActiveAssignment {
  assignment_id: string;
  vehicle_id: string;
  vehicle_number: string;
  driver_id: string;
  driver_name: string;
  driver_employee_number: string;
  allocation_date: string;
}

/**
 * Latest active allocation for a vehicle. A vehicle should only have one, but
 * older databases may contain duplicates, so pick the newest deterministically.
 */
export const VEHICLE_ACTIVE_DRIVER_JOIN = `
  LEFT JOIN vehicle_allocations va_active ON va_active.id = (
    SELECT va2.id
    FROM vehicle_allocations va2
    WHERE va2.vehicle_id = v.id AND va2.authorisation_status = 'active'
    ORDER BY va2.allocation_date DESC, va2.created_at DESC
    LIMIT 1
  )
  LEFT JOIN drivers d_active ON d_active.id = va_active.driver_id
`;

/** Latest active allocation for a driver. */
export const DRIVER_ACTIVE_VEHICLE_JOIN = `
  LEFT JOIN vehicle_allocations va_active ON va_active.id = (
    SELECT va2.id
    FROM vehicle_allocations va2
    WHERE va2.driver_id = d.id AND va2.authorisation_status = 'active'
    ORDER BY va2.allocation_date DESC, va2.created_at DESC
    LIMIT 1
  )
  LEFT JOIN vehicles v_active ON v_active.id = va_active.vehicle_id
`;

function closeVehicleAllocations(vehicleId: string) {
  db.prepare(`
    UPDATE vehicle_allocations
    SET authorisation_status = 'expired',
        return_date = COALESCE(return_date, date('now'))
    WHERE vehicle_id = ? AND authorisation_status = 'active'
  `).run(vehicleId);
}

function closeDriverAllocations(driverId: string) {
  db.prepare(`
    UPDATE vehicle_allocations
    SET authorisation_status = 'expired',
        return_date = COALESCE(return_date, date('now'))
    WHERE driver_id = ? AND authorisation_status = 'active'
  `).run(driverId);
}

export function getActiveDriverForVehicle(vehicleId: string): ActiveAssignment | null {
  return (db.prepare(`
    SELECT
      va.id AS assignment_id,
      va.vehicle_id,
      v.vehicle_number,
      va.driver_id,
      d.name AS driver_name,
      d.employee_number AS driver_employee_number,
      va.allocation_date
    FROM vehicle_allocations va
    JOIN vehicles v ON v.id = va.vehicle_id
    JOIN drivers d ON d.id = va.driver_id
    WHERE va.vehicle_id = ? AND va.authorisation_status = 'active'
    ORDER BY va.allocation_date DESC, va.created_at DESC
    LIMIT 1
  `).get(vehicleId) as ActiveAssignment | undefined) ?? null;
}

export function getActiveVehicleForDriver(driverId: string): ActiveAssignment | null {
  return (db.prepare(`
    SELECT
      va.id AS assignment_id,
      va.vehicle_id,
      v.vehicle_number,
      va.driver_id,
      d.name AS driver_name,
      d.employee_number AS driver_employee_number,
      va.allocation_date
    FROM vehicle_allocations va
    JOIN vehicles v ON v.id = va.vehicle_id
    JOIN drivers d ON d.id = va.driver_id
    WHERE va.driver_id = ? AND va.authorisation_status = 'active'
    ORDER BY va.allocation_date DESC, va.created_at DESC
    LIMIT 1
  `).get(driverId) as ActiveAssignment | undefined) ?? null;
}

/**
 * Assigns a driver to a vehicle, or clears the vehicle's active driver when
 * `driverId` is null. Previous active allocations for both sides are closed so
 * a driver and a vehicle each have at most one active assignment.
 */
export function assignDriverToVehicle(
  vehicleId: string,
  driverId: string | null,
  actorId?: string | null,
): ActiveAssignment | null {
  const vehicle = db.prepare(`
    SELECT id, vehicle_number, department FROM vehicles WHERE id = ?
  `).get(vehicleId) as { id: string; vehicle_number: string; department: string | null } | undefined;
  if (!vehicle) throw new AssignmentError(404, "Vehicle not found");

  let driver: { id: string; name: string; department: string | null; authorisation_status: string } | undefined;
  if (driverId) {
    driver = db.prepare(`
      SELECT id, name, department, authorisation_status FROM drivers WHERE id = ?
    `).get(driverId) as typeof driver;
    if (!driver) throw new AssignmentError(404, "Driver not found");
    if (driver.authorisation_status !== "authorised") {
      throw new AssignmentError(400, "Only authorised drivers can be assigned to a vehicle");
    }
  }

  const apply = db.transaction(() => {
    closeVehicleAllocations(vehicleId);
    if (!driverId || !driver) return null;

    closeDriverAllocations(driverId);
    const allocationId = uuid();
    db.prepare(`
      INSERT INTO vehicle_allocations (
        id, vehicle_id, department, custodian, driver_id, allocation_date,
        approval_status, authorisation_status, notes
      ) VALUES (?, ?, ?, ?, ?, date('now'), 'approved', 'active', ?)
    `).run(
      allocationId,
      vehicleId,
      driver.department ?? vehicle.department ?? null,
      driver.name,
      driverId,
      "Assigned from vehicle register",
    );
    return allocationId;
  });

  const allocationId = apply();
  writeAudit({
    userId: actorId ?? null,
    action: driverId ? "VEHICLE_DRIVER_ASSIGNED" : "VEHICLE_DRIVER_UNASSIGNED",
    entity: "vehicles",
    entityId: vehicleId,
    newValue: { driverId, allocationId },
  });

  return driverId ? getActiveDriverForVehicle(vehicleId) : null;
}

/**
 * Assigns a vehicle to a driver, or clears the driver's active vehicle when
 * `vehicleId` is null.
 */
export function assignVehicleToDriver(
  driverId: string,
  vehicleId: string | null,
  actorId?: string | null,
): ActiveAssignment | null {
  const driver = db.prepare("SELECT id, name FROM drivers WHERE id = ?").get(driverId) as
    | { id: string; name: string }
    | undefined;
  if (!driver) throw new AssignmentError(404, "Driver not found");

  if (vehicleId) return assignDriverToVehicle(vehicleId, driverId, actorId);

  const apply = db.transaction(() => {
    closeDriverAllocations(driverId);
  });
  apply();

  writeAudit({
    userId: actorId ?? null,
    action: "DRIVER_VEHICLE_UNASSIGNED",
    entity: "drivers",
    entityId: driverId,
    newValue: { vehicleId: null },
  });

  return null;
}
