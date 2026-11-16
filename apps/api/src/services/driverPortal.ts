import { v4 as uuid } from "uuid";
import { Request } from "express";
import { db } from "../db";
import { ApiError } from "../middleware/errorHandler";
import { writeAudit } from "../utils/audit";

/**
 * Shared helpers for the Driver Portal. Every helper is scoped to the
 * authenticated driver — the driver id is always resolved server-side from
 * `users.driver_id`; client-supplied identifiers are never trusted.
 */

export interface DriverContext {
  userId: string;
  driverId: string;
}

export interface DriverRecord {
  id: string;
  employee_number: string;
  name: string;
  department: string | null;
  licence_number: string;
  licence_class: string | null;
  licence_expiry: string;
  authorisation_status: string;
  accident_history: string | null;
  training: string | null;
}

export function resolveDriverId(userId: string): string | null {
  const row = db.prepare("SELECT driver_id FROM users WHERE id = ? AND status = 'active'").get(userId) as { driver_id: string | null } | undefined;
  return row?.driver_id ?? null;
}

/** Resolves the authenticated driver's context or throws a 403. */
export function requireDriverContext(req: Request): DriverContext {
  const userId = req.user?.id;
  if (!userId) throw new ApiError(401, "Not authenticated");
  const driverId = resolveDriverId(userId);
  if (!driverId) throw new ApiError(403, "No driver record is linked to this account. Contact an administrator.");
  return { userId, driverId };
}

export function getDriver(driverId: string): DriverRecord | undefined {
  return db.prepare("SELECT * FROM drivers WHERE id = ?").get(driverId) as DriverRecord | undefined;
}

export interface AssignedVehicle {
  id: string;
  vehicle_number: string;
  registration_number: string;
  make: string;
  model: string;
  vehicle_type: string;
  fuel_type: string;
  department: string | null;
  location: string | null;
  status: string;
  current_odometer: number;
  tank_capacity_litres: number | null;
  expected_km_per_l: number | null;
  allocation_id: string;
  allocation_date: string;
  return_date: string | null;
}

/** The driver's currently active, approved vehicle allocation (or null). */
export function getAssignedVehicle(driverId: string): AssignedVehicle | undefined {
  return db.prepare(`
    SELECT
      v.id, v.vehicle_number, v.registration_number, v.make, v.model, v.vehicle_type,
      v.fuel_type, v.department, v.location, v.status, v.current_odometer,
      v.tank_capacity_litres, v.expected_km_per_l,
      va.id AS allocation_id, va.allocation_date, va.return_date
    FROM vehicle_allocations va
    JOIN vehicles v ON v.id = va.vehicle_id
    WHERE va.driver_id = ?
      AND va.authorisation_status = 'active'
      AND va.approval_status = 'approved'
      AND (va.return_date IS NULL OR va.return_date >= date('now'))
    ORDER BY va.allocation_date DESC
    LIMIT 1
  `).get(driverId) as AssignedVehicle | undefined;
}

/** True when the vehicle must not be driven (under repair or has an open critical fault). */
export function getVehicleBlockReason(vehicleId: string): string | null {
  const vehicle = db.prepare("SELECT status FROM vehicles WHERE id = ?").get(vehicleId) as { status: string } | undefined;
  if (!vehicle) return "Vehicle not found";
  if (vehicle.status === "under_repair") return "Vehicle is flagged under repair pending clearance";
  if (vehicle.status === "disposed" || vehicle.status === "inactive") return `Vehicle is ${vehicle.status}`;
  const critical = db.prepare(`
    SELECT COUNT(*) AS count FROM vehicle_faults
    WHERE vehicle_id = ? AND severity = 'critical' AND status IN ('open', 'acknowledged', 'in_progress')
  `).get(vehicleId) as { count: number };
  if (critical.count > 0) return "Vehicle has an unresolved critical fault";
  const failedInspection = db.prepare(`
    SELECT COUNT(*) AS count FROM vehicle_inspections
    WHERE vehicle_id = ? AND result = 'fail' AND cleared = 0
  `).get(vehicleId) as { count: number };
  if (failedInspection.count > 0) return "Vehicle has an unresolved failed inspection";
  return null;
}

export interface SafetyMetrics {
  safetyScore: number;
  riskRating: "low" | "medium" | "high";
  speedingCount: number;
  harshBrakingCount: number;
  harshAccelCount: number;
  idlingCount: number;
  totalEvents: number;
  monthlyTrend: { month: string; speeding: number; harshBraking: number; harshAccel: number; idling: number; total: number }[];
}

/**
 * Safety figures derived ONLY from recorded driver_events for this driver —
 * never fabricated. Same scoring model as driverIntelligence.
 */
export function computeSafety(driverId: string): SafetyMetrics {
  const events = db.prepare("SELECT event_type FROM driver_events WHERE driver_id = ?").all(driverId) as { event_type: string }[];
  const speedingCount = events.filter((e) => e.event_type === "speeding").length;
  const harshBrakingCount = events.filter((e) => e.event_type === "harsh_braking").length;
  const harshAccelCount = events.filter((e) => e.event_type === "harsh_accel").length;
  const idlingCount = events.filter((e) => e.event_type === "excessive_idling").length;

  const penalty = speedingCount * 10 + harshBrakingCount * 5 + harshAccelCount * 5 + idlingCount * 3;
  const safetyScore = Math.max(0, 100 - penalty);
  const riskRating: "low" | "medium" | "high" = safetyScore < 60 ? "high" : safetyScore < 80 ? "medium" : "low";

  const monthlyTrend = db.prepare(`
    SELECT
      strftime('%Y-%m', recorded_at) AS month,
      SUM(CASE WHEN event_type = 'speeding' THEN 1 ELSE 0 END) AS speeding,
      SUM(CASE WHEN event_type = 'harsh_braking' THEN 1 ELSE 0 END) AS harshBraking,
      SUM(CASE WHEN event_type = 'harsh_accel' THEN 1 ELSE 0 END) AS harshAccel,
      SUM(CASE WHEN event_type = 'excessive_idling' THEN 1 ELSE 0 END) AS idling,
      COUNT(*) AS total
    FROM driver_events
    WHERE driver_id = ?
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all(driverId) as SafetyMetrics["monthlyTrend"];

  return { safetyScore, riskRating, speedingCount, harshBrakingCount, harshAccelCount, idlingCount, totalEvents: events.length, monthlyTrend };
}

export interface NotifyInput {
  userId: string;
  driverId?: string | null;
  title: string;
  body: string;
  category?: string;
  relatedEntity?: string | null;
  relatedId?: string | null;
  createdBy?: string | null;
}

export function createNotification(input: NotifyInput): string {
  const id = uuid();
  db.prepare(`
    INSERT INTO driver_notifications (id, user_id, driver_id, title, body, category, related_entity, related_id, is_read, created_by)
    VALUES (@id, @userId, @driverId, @title, @body, @category, @relatedEntity, @relatedId, 0, @createdBy)
  `).run({
    id,
    userId: input.userId,
    driverId: input.driverId ?? null,
    title: input.title,
    body: input.body,
    category: input.category ?? "general",
    relatedEntity: input.relatedEntity ?? null,
    relatedId: input.relatedId ?? null,
    createdBy: input.createdBy ?? null,
  });
  return id;
}

/** Raises an operational alert for admin review. */
export function createAlert(severity: "critical" | "warning", assetType: string, assetId: string | null, category: string, description: string): string {
  const id = uuid();
  db.prepare(`
    INSERT INTO alerts (id, severity, asset_type, asset_id, category, description, status)
    VALUES (?, ?, ?, ?, ?, ?, 'open')
  `).run(id, severity, assetType, assetId, category, description);
  return id;
}

/** Marks a vehicle under repair (used for critical faults / failed inspections). */
export function flagVehicleUnderRepair(vehicleId: string) {
  db.prepare("UPDATE vehicles SET status = 'under_repair', updated_at = datetime('now') WHERE id = ?").run(vehicleId);
}

/**
 * Clears the under_repair flag when no other blocking condition remains.
 * Called after an admin clears a critical fault / failed inspection.
 */
export function maybeClearVehicleFlag(vehicleId: string) {
  const openCritical = db.prepare(`
    SELECT COUNT(*) AS count FROM vehicle_faults
    WHERE vehicle_id = ? AND severity = 'critical' AND status IN ('open', 'acknowledged', 'in_progress')
  `).get(vehicleId) as { count: number };
  const failedInspections = db.prepare(`
    SELECT COUNT(*) AS count FROM vehicle_inspections WHERE vehicle_id = ? AND result = 'fail' AND cleared = 0
  `).get(vehicleId) as { count: number };
  if (openCritical.count === 0 && failedInspections.count === 0) {
    db.prepare("UPDATE vehicles SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'under_repair'").run(vehicleId);
  }
}

export function auditDriverAction(
  req: Request,
  action: string,
  entity: string,
  entityId: string | null,
  newValue?: unknown,
  previousValue?: unknown
) {
  writeAudit({
    userId: req.user?.id ?? null,
    role: req.user?.roleName ?? null,
    action,
    entity,
    entityId,
    newValue,
    previousValue,
    ipAddress: req.ip,
    device: (req.headers["user-agent"] as string) ?? null,
  });
}
