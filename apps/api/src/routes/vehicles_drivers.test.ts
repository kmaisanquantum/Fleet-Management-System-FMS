import { describe, it, expect, beforeAll } from "vitest";
import { db, initSchema } from "../db";
import { v4 as uuid } from "uuid";
import { writeAudit } from "../utils/audit";

describe("Vehicles and Drivers deletion and audit tests", () => {
  let vehicleId: string;
  let vehicleWithFkId: string;
  let driverId: string;
  let driverWithFkId: string;

  beforeAll(() => {
    initSchema();
    const s = uuid().substring(0, 6);
    vehicleId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, year, vehicle_type, fuel_type, department, status)
      VALUES (?, ?, ?, 'Toyota', 'Hilux', 2022, 'Utility', 'Diesel', 'Ops', 'active')
    `).run(vehicleId, `VT1-${s}`, `REG1-${s}`);

    vehicleWithFkId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, year, vehicle_type, fuel_type, department, status)
      VALUES (?, ?, ?, 'Ford', 'Ranger', 2023, 'Utility', 'Diesel', 'Ops', 'active')
    `).run(vehicleWithFkId, `VT2-${s}`, `REG2-${s}`);

    driverId = uuid();
    db.prepare(`
      INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_expiry, authorisation_status)
      VALUES (?, ?, 'Test Driver', 'Ops', ?, '2028-01-01', 'authorised')
    `).run(driverId, `EMP1-${s}`, `DL1-${s}`);

    driverWithFkId = uuid();
    db.prepare(`
      INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_expiry, authorisation_status)
      VALUES (?, ?, 'Test Driver FK', 'Ops', ?, '2028-01-01', 'authorised')
    `).run(driverWithFkId, `EMP2-${s}`, `DL2-${s}`);

    // Insert linked record referencing vehicleWithFkId and driverWithFkId
    db.prepare(`
      INSERT INTO vehicle_fuel_logs (id, vehicle_id, driver_id, date, fuel_type, litres, cost_per_litre, total_cost, odometer_reading)
      VALUES (?, ?, ?, '2026-03-01', 'Diesel', 50, 2.5, 125, 10000)
    `).run(uuid(), vehicleWithFkId, driverWithFkId);
  });

  it("deletes a vehicle without linked records and logs audit", () => {
    const existing = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(vehicleId);
    expect(existing).toBeDefined();

    db.prepare("DELETE FROM vehicles WHERE id = ?").run(vehicleId);
    writeAudit({ action: "VEHICLE_DELETED", entity: "vehicles", entityId: vehicleId, previousValue: existing });

    const check = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(vehicleId);
    expect(check).toBeUndefined();

    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'VEHICLE_DELETED' AND entity_id = ?").get(vehicleId) as any;
    expect(audit).toBeDefined();
  });

  it("fails deletion when foreign key constraints exist on vehicle", () => {
    expect(() => {
      db.prepare("DELETE FROM vehicles WHERE id = ?").run(vehicleWithFkId);
    }).toThrow();
  });

  it("deletes a driver without linked records and logs audit", () => {
    const existing = db.prepare("SELECT * FROM drivers WHERE id = ?").get(driverId);
    expect(existing).toBeDefined();

    db.prepare("DELETE FROM drivers WHERE id = ?").run(driverId);
    writeAudit({ action: "DRIVER_DELETED", entity: "drivers", entityId: driverId, previousValue: existing });

    const check = db.prepare("SELECT * FROM drivers WHERE id = ?").get(driverId);
    expect(check).toBeUndefined();

    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'DRIVER_DELETED' AND entity_id = ?").get(driverId) as any;
    expect(audit).toBeDefined();
  });

  it("fails deletion when foreign key constraints exist on driver", () => {
    expect(() => {
      db.prepare("DELETE FROM drivers WHERE id = ?").run(driverWithFkId);
    }).toThrow();
  });
});
