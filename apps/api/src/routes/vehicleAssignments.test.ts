import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { signAccessToken } from "../middleware/auth";
import vehiclesRouter from "./vehicles";
import driversRouter from "./drivers";

let server: Server;
let baseUrl: string;
let token: string;

const vehicleA = uuid();
const vehicleB = uuid();
const driverA = uuid();
const driverB = uuid();
const suspendedDriver = uuid();
const detailVehicle = uuid();
const detailDriver = uuid();
const adminUserId = uuid();
const adminRoleId = uuid();
const suffix = uuid().substring(0, 8);

function authFetch(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
}

function insertVehicle(id: string, number: string) {
  db.prepare(`
    INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, year, vehicle_type, fuel_type, department, status)
    VALUES (?, ?, ?, 'Toyota', 'Hilux', 2024, 'Utility', 'Diesel', 'Operations', 'active')
  `).run(id, number, `REG-${number}`);
}

function insertDriver(id: string, employeeNumber: string, status = "authorised") {
  db.prepare(`
    INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_expiry, authorisation_status)
    VALUES (?, ?, ?, 'Operations', ?, '2030-01-01', ?)
  `).run(id, employeeNumber, `Driver ${employeeNumber}`, `DL-${employeeNumber}`, status);
}

beforeAll(async () => {
  initSchema();

  db.prepare("INSERT INTO roles (id, name, description) VALUES (?, ?, 'Test administrator')").run(adminRoleId, `test-admin-${suffix}`);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, full_name, role_id, status)
    VALUES (?, ?, 'x', 'Test Admin', ?, 'active')
  `).run(adminUserId, `admin-${suffix}@example.test`, adminRoleId);

  insertVehicle(vehicleA, `VA-${suffix}`);
  insertVehicle(vehicleB, `VB-${suffix}`);
  insertVehicle(detailVehicle, `VD-${suffix}`);
  insertDriver(driverA, `EA-${suffix}`);
  insertDriver(driverB, `EB-${suffix}`);
  insertDriver(suspendedDriver, `ES-${suffix}`, "suspended");
  insertDriver(detailDriver, `ED-${suffix}`);

  const tripId = uuid();
  db.prepare(`
    INSERT INTO vehicle_trips (
      id, vehicle_id, driver_id, date, start_location, destination,
      begin_odometer, end_odometer, total_km
    ) VALUES (?, ?, ?, '2026-11-01', 'Port Moresby', 'Lae', 1000, 1500, 500)
  `).run(tripId, detailVehicle, detailDriver);

  const fuelId = uuid();
  db.prepare(`
    INSERT INTO vehicle_fuel_logs (
      id, vehicle_id, driver_id, date, fuel_type, litres, cost_per_litre,
      total_cost, odometer_reading, km_per_l
    ) VALUES (?, ?, ?, '2026-11-02', 'Diesel', 60, 2.5, 150, 1500, 8.3)
  `).run(fuelId, detailVehicle, detailDriver);

  db.prepare(`
    INSERT INTO fleet_exceptions (
      id, severity, category, rule_code, vehicle_id, driver_id, description, status
    ) VALUES (?, 'warning', 'driver', 'RULE_TEST', ?, ?, 'Test exception', 'open')
  `).run(uuid(), detailVehicle, detailDriver);

  db.prepare(`
    INSERT INTO driver_events (id, event_type, vehicle_id, driver_id, recorded_at, value)
    VALUES (?, 'speeding', ?, ?, '2026-11-03 10:00:00', 95)
  `).run(uuid(), detailVehicle, detailDriver);

  const app = express();
  app.use(express.json());
  app.use("/api/v1/vehicles", vehiclesRouter);
  app.use("/api/v1/drivers", driversRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  token = signAccessToken({
    id: adminUserId,
    email: "admin@dspng.tech",
    roleName: "admin",
    airportId: null,
    clientIds: [],
  });
});

afterAll(() => {
  const ids = [vehicleA, vehicleB, detailVehicle];
  const driverIds = [driverA, driverB, suspendedDriver, detailDriver];
  db.prepare(`DELETE FROM driver_events WHERE driver_id IN (${driverIds.map(() => "?").join(",")})`).run(...driverIds);
  db.prepare(`DELETE FROM fleet_exceptions WHERE driver_id IN (${driverIds.map(() => "?").join(",")})`).run(...driverIds);
  db.prepare(`DELETE FROM vehicle_trips WHERE vehicle_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  db.prepare(`DELETE FROM vehicle_fuel_logs WHERE vehicle_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  db.prepare(`DELETE FROM vehicle_allocations WHERE vehicle_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  db.prepare(`DELETE FROM drivers WHERE id IN (${driverIds.map(() => "?").join(",")})`).run(...driverIds);
  db.prepare(`DELETE FROM vehicles WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  db.prepare("DELETE FROM audit_logs WHERE user_id = ?").run(adminUserId);
  db.prepare("DELETE FROM users WHERE id = ?").run(adminUserId);
  db.prepare("DELETE FROM roles WHERE id = ?").run(adminRoleId);
  server?.close();
});

describe("vehicle and driver assignment", () => {
  it("assigns a driver to a vehicle and exposes the driver on the vehicle list", async () => {
    const res = await authFetch(`/api/v1/vehicles/${vehicleA}/driver`, {
      method: "PUT",
      body: JSON.stringify({ driverId: driverA }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.driver_id).toBe(driverA);

    const list = await authFetch("/api/v1/vehicles");
    const listBody: any = await list.json();
    const row = listBody.data.find((v: any) => v.id === vehicleA);
    expect(row.assigned_driver_id).toBe(driverA);
    expect(row.assigned_driver_name).toContain(`EA-${suffix}`);
  });

  it("assigns a vehicle from the driver side and closes the previous vehicle allocation", async () => {
    const res = await authFetch(`/api/v1/drivers/${driverA}/vehicle`, {
      method: "PUT",
      body: JSON.stringify({ vehicleId: vehicleB }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.vehicle_id).toBe(vehicleB);

    const previous = db.prepare(`
      SELECT authorisation_status FROM vehicle_allocations
      WHERE vehicle_id = ? AND driver_id = ?
    `).get(vehicleA, driverA) as { authorisation_status: string };
    expect(previous.authorisation_status).toBe("expired");

    const drivers = await authFetch("/api/v1/drivers");
    const driversBody: any = await drivers.json();
    const row = driversBody.data.find((d: any) => d.id === driverA);
    expect(row.assigned_vehicle_id).toBe(vehicleB);
    expect(row.assigned_vehicle_number).toBe(`VB-${suffix}`);
  });

  it("reassigning a vehicle releases the previous driver", async () => {
    const res = await authFetch(`/api/v1/vehicles/${vehicleB}/driver`, {
      method: "PUT",
      body: JSON.stringify({ driverId: driverB }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.driver_id).toBe(driverB);

    const driver = await authFetch(`/api/v1/drivers/${driverA}`);
    const driverBody: any = await driver.json();
    const row = driverBody.data;
    expect(row.assigned_vehicle_id).toBeNull();
  });

  it("unassigns a vehicle", async () => {
    const res = await authFetch(`/api/v1/vehicles/${vehicleB}/driver`, {
      method: "PUT",
      body: JSON.stringify({ driverId: null }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toBeNull();

    const vehicle = await authFetch(`/api/v1/vehicles/${vehicleB}`);
    const vehicleBody: any = await vehicle.json();
    expect(vehicleBody.data.assigned_driver_id).toBeNull();
  });

  it("rejects assigning a driver who is not authorised", async () => {
    const res = await authFetch(`/api/v1/vehicles/${vehicleA}/driver`, {
      method: "PUT",
      body: JSON.stringify({ driverId: suspendedDriver }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain("authorised");
  });

  it("returns the driver profile with linked vehicle, trips, fuel, exceptions, and events", async () => {
    const assign = await authFetch(`/api/v1/drivers/${detailDriver}/vehicle`, {
      method: "PUT",
      body: JSON.stringify({ vehicleId: detailVehicle }),
    });
    expect(assign.status).toBe(200);

    const res = await authFetch(`/api/v1/drivers/${detailDriver}/intelligence`);
    expect(res.status).toBe(200);
    const { data }: any = await res.json();

    expect(data.profile.id).toBe(detailDriver);
    expect(data.profile.assigned_vehicle_id).toBe(detailVehicle);
    expect(data.allocations).toHaveLength(1);
    expect(data.trips).toHaveLength(1);
    expect(data.fuelLogs).toHaveLength(1);
    expect(data.exceptions).toHaveLength(1);
    expect(data.events).toHaveLength(1);
    expect(data.metrics.safetyScore).toBe(90);
    expect(data.summary.totalKm).toBe(500);
  });
});
