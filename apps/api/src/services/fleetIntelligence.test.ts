import { describe, it, expect, beforeAll } from "vitest";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { buildFleetIntelligence } from "./fleetIntelligence";

describe("Fleet intelligence", () => {
  let clientAId: string;
  let clientBId: string;
  let vehicleAId: string;
  let vehicleBId: string;
  let driverAId: string;
  let driverBId: string;
  const now = new Date("2026-11-24T02:00:00Z");

  beforeAll(() => {
    initSchema();
    const suffix = uuid().slice(0, 8);
    clientAId = uuid();
    clientBId = uuid();
    vehicleAId = uuid();
    vehicleBId = uuid();
    driverAId = uuid();
    driverBId = uuid();

    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientAId, `Client A ${suffix}`);
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientBId, `Client B ${suffix}`);

    db.prepare(`
      INSERT INTO vehicles (
        id, vehicle_number, registration_number, make, model, year, vehicle_type,
        fuel_type, department, client_id, status, registration_expiry, insurance_expiry,
        expected_km_per_l, last_seen_at
      ) VALUES (?, ?, ?, 'Toyota', 'Hilux', 2022, 'Utility', 'Diesel', 'Ops', ?, 'active',
        '2026-11-20', '2026-12-01', 10.0, NULL)
    `).run(vehicleAId, `AI-VA-${suffix}`, `AI-RA-${suffix}`, clientAId);

    db.prepare(`
      INSERT INTO vehicles (
        id, vehicle_number, registration_number, make, model, year, vehicle_type,
        fuel_type, department, client_id, status, expected_km_per_l, last_seen_at
      ) VALUES (?, ?, ?, 'Ford', 'Ranger', 2023, 'Utility', 'Diesel', 'Ops', ?, 'active', 8.0, '2026-11-24 01:50:00')
    `).run(vehicleBId, `AI-VB-${suffix}`, `AI-RB-${suffix}`, clientBId);

    db.prepare(`
      INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_expiry, authorisation_status)
      VALUES (?, ?, 'Driver A', 'Ops', ?, '2026-11-01', 'authorised')
    `).run(driverAId, `AI-EA-${suffix}`, `AI-DA-${suffix}`);

    db.prepare(`
      INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_expiry, authorisation_status)
      VALUES (?, ?, 'Driver B', 'Ops', ?, '2027-01-01', 'authorised')
    `).run(driverBId, `AI-EB-${suffix}`, `AI-DB-${suffix}`);

    for (const [vehicleId, driverId] of [
      [vehicleAId, driverAId],
      [vehicleBId, driverBId],
    ]) {
      db.prepare(`
        INSERT INTO vehicle_allocations (id, vehicle_id, driver_id, allocation_date, approval_status, authorisation_status)
        VALUES (?, ?, ?, '2026-11-01', 'approved', 'active')
      `).run(uuid(), vehicleId, driverId);
    }

    db.prepare(`
      INSERT INTO vehicle_maintenance (id, vehicle_id, maintenance_type, description, scheduled_date, status)
      VALUES (?, ?, 'scheduled_service', 'AI overdue service', '2026-11-10', 'scheduled')
    `).run(uuid(), vehicleAId);
    db.prepare(`
      INSERT INTO vehicle_maintenance (id, vehicle_id, maintenance_type, description, scheduled_date, status)
      VALUES (?, ?, 'scheduled_service', 'AI due-soon service', '2026-11-27', 'scheduled')
    `).run(uuid(), vehicleBId);

    db.prepare(`
      INSERT INTO vehicle_fuel_logs (
        id, vehicle_id, driver_id, date, fuel_type, litres, cost_per_litre, total_cost, odometer_reading, km_per_l
      ) VALUES (?, ?, ?, '2026-11-23', 'Diesel', 50, 4, 200, 50000, 4.0)
    `).run(uuid(), vehicleAId, driverAId);

    db.prepare(`
      INSERT INTO fuel_card_transactions (
        id, card_number, vehicle_id, transaction_at, liters, status, flag_reason
      ) VALUES (?, ?, ?, '2026-11-23 10:00:00', 40, 'flagged', 'AI test')
    `).run(uuid(), `AI-CARD-${suffix}`, vehicleAId);

    db.prepare(`
      INSERT INTO camera_feeds (id, name, scope, client_id, last_seen_at, is_active)
      VALUES (?, 'AI depot camera', 'depot', ?, NULL, 1)
    `).run(uuid(), clientAId);

    db.prepare(`
      INSERT INTO vehicle_breakdowns (id, vehicle_id, breakdown_date, location, description, status)
      VALUES (?, ?, '2026-11-23', 'Depot', 'AI breakdown', 'reported')
    `).run(uuid(), vehicleAId);

    db.prepare(`
      INSERT INTO vehicle_inspections (id, vehicle_id, inspector_name, inspection_date, result, checklist)
      VALUES (?, ?, 'Inspector', '2026-11-23', 'fail', '{}')
    `).run(uuid(), vehicleAId);

    db.prepare(`
      INSERT INTO fleet_exceptions (id, severity, category, rule_code, vehicle_id, driver_id, description, status)
      VALUES (?, 'critical', 'fuel', 'AI_RULE', ?, ?, 'AI critical exception', 'open')
    `).run(uuid(), vehicleAId, driverAId);

    for (const eventType of ["speeding", "speeding", "harsh_braking"]) {
      db.prepare(`
        INSERT INTO driver_events (id, event_type, vehicle_id, driver_id, recorded_at, value)
        VALUES (?, ?, ?, ?, '2026-11-24 01:00:00', 1)
      `).run(uuid(), eventType, vehicleAId, driverAId);
    }
  });

  it("builds a ranked, explainable health briefing", () => {
    const result = buildFleetIntelligence({ scopes: [clientAId], now, limit: 50 });

    expect(result.coverage.vehicles).toBe(1);
    expect(result.coverage.onlineVehicles).toBe(0);
    expect(result.health.score).toBeLessThan(100);
    expect(result.insights.some((insight) => insight.category === "exceptions" && insight.severity === "critical")).toBe(true);
    expect(result.insights.some((insight) => insight.id.startsWith("maintenance:overdue:"))).toBe(true);
    expect(result.insights.some((insight) => insight.title.includes("Driver licence expired"))).toBe(true);
    expect(result.insights.some((insight) => insight.title.includes("Fuel efficiency below target"))).toBe(true);
    expect(result.insights.some((insight) => insight.category === "operations" && insight.title.includes("camera"))).toBe(true);
    expect(result.insights.some((insight) => insight.category === "safety")).toBe(true);
  });

  it("does not leak another client's vehicle or driver signals", () => {
    const result = buildFleetIntelligence({ scopes: [clientBId], now, limit: 50 });

    expect(result.coverage.vehicles).toBe(1);
    expect(result.coverage.onlineVehicles).toBe(1);
    expect(result.insights.some((insight) => insight.entityId === vehicleAId)).toBe(false);
    expect(result.insights.some((insight) => insight.title.includes("Driver licence expired"))).toBe(false);
    expect(result.insights.some((insight) => insight.title.includes("Fuel efficiency below target"))).toBe(false);
  });

  it("returns the full fleet when no client scope is supplied", () => {
    const result = buildFleetIntelligence({ now, limit: 50 });

    expect(result.coverage.vehicles).toBeGreaterThanOrEqual(2);
    expect(result.insights.some((insight) => insight.entityId === vehicleAId)).toBe(true);
    expect(result.insights.some((insight) => insight.entityId === vehicleBId)).toBe(true);
  });
});
