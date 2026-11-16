import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { errorHandler } from "../middleware/errorHandler";
import { signAccessToken } from "../middleware/auth";
import driverPortalRouter from "./driverPortal";

/**
 * Route-level tests for the Driver Portal.
 *
 * These boot the real router (including requireAuth + requireRole("driver"))
 * on an ephemeral HTTP server, so authentication, role enforcement and
 * driver-scoping are exercised end-to-end. All identifiers are unique per run
 * so the tests never collide with the seeded database or other suites.
 */

interface Seed {
  driverId: string;
  userId: string;
  vehicleId: string;
  allocationId: string;
  employeeNumber: string;
  token: string;
}

function seedDriver(tag: string): Seed {
  const s = uuid().substring(0, 8);

  let role = db.prepare("SELECT id FROM roles WHERE name = 'driver'").get() as { id: string } | undefined;
  if (!role) {
    role = { id: uuid() };
    db.prepare("INSERT INTO roles (id, name, description) VALUES (?, 'driver', 'Driver')").run(role.id);
  }

  const driverId = uuid();
  const employeeNumber = `EMP-${tag}-${s}`;
  db.prepare(`
    INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_class, licence_expiry, authorisation_status)
    VALUES (?, ?, ?, 'Ops', ?, 'B', '2030-01-01', 'authorised')
  `).run(driverId, employeeNumber, `Driver ${tag}`, `DL-${tag}-${s}`);

  const userId = uuid();
  const email = `driver_${tag}_${s}@dspng.tech`;
  db.prepare(`
    INSERT INTO users (id, email, password_hash, full_name, role_id, driver_id, status)
    VALUES (?, ?, 'hash', ?, ?, ?, 'active')
  `).run(userId, email, `Driver ${tag}`, role.id, driverId);

  const vehicleId = uuid();
  db.prepare(`
    INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, year, vehicle_type, fuel_type, department, status, current_odometer)
    VALUES (?, ?, ?, 'Toyota', 'Hilux', 2022, 'Utility', 'Diesel', 'Ops', 'active', 1000)
  `).run(vehicleId, `VN-${tag}-${s}`, `REG-${tag}-${s}`);

  const allocationId = uuid();
  db.prepare(`
    INSERT INTO vehicle_allocations (id, vehicle_id, driver_id, allocation_date, approval_status, authorisation_status)
    VALUES (?, ?, ?, date('now'), 'approved', 'active')
  `).run(allocationId, vehicleId, driverId);

  const token = signAccessToken({ id: userId, email, roleName: "driver", airportId: null });
  return { driverId, userId, vehicleId, allocationId, employeeNumber, token };
}

let server: Server;
let base: string;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  initSchema();

  const app = express();
  app.use(express.json());
  app.use("/api/v1/driver-portal", driverPortalRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  a = seedDriver("A");
  b = seedDriver("B");
});

afterAll(() => {
  server?.close();
});

async function api(path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api/v1/driver-portal${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body } as { status: number; body: any };
}

describe("Driver Portal — authentication & role enforcement", () => {
  it("rejects unauthenticated requests", async () => {
    const { status } = await api("/dashboard");
    expect(status).toBe(401);
  });

  it("rejects non-driver roles", async () => {
    const adminToken = signAccessToken({ id: uuid(), email: "admin@dspng.tech", roleName: "admin", airportId: null });
    const { status } = await api("/dashboard", { token: adminToken });
    expect(status).toBe(403);
  });
});

describe("Driver Portal — profile & vehicle scoping", () => {
  it("returns the authenticated driver's own profile", async () => {
    const { status, body } = await api("/profile", { token: a.token });
    expect(status).toBe(200);
    expect(body.data.employeeNumber).toBe(a.employeeNumber);
  });

  it("returns only the driver's own assigned vehicle", async () => {
    const { status, body } = await api("/vehicle", { token: a.token });
    expect(status).toBe(200);
    expect(body.data.id).toBe(a.vehicleId);
    expect(body.data.id).not.toBe(b.vehicleId);
  });
});

describe("Driver Portal — trips", () => {
  let activeTripId: string;

  it("starts a trip on the assigned vehicle", async () => {
    const { status, body } = await api("/trips/start", {
      token: a.token,
      method: "POST",
      body: { startLocation: "Depot", destination: "Airport", purpose: "Cargo", beginOdometer: 1000 },
    });
    expect(status).toBe(201);
    expect(body.data.driver_id).toBe(a.driverId);
    activeTripId = body.data.id;
  });

  it("ends the active trip and computes distance", async () => {
    const { status, body } = await api(`/trips/${activeTripId}/end`, {
      token: a.token,
      method: "POST",
      body: { endOdometer: 1050 },
    });
    expect(status).toBe(200);
    expect(body.data.total_km).toBe(50);
    expect(body.data.time_in).toBeTruthy();
  });

  it("scopes trip listing to the authenticated driver", async () => {
    // Driver B has their own trip record.
    db.prepare(`
      INSERT INTO vehicle_trips (id, vehicle_id, driver_id, date, time_out, start_location, destination, begin_odometer, end_odometer, total_km)
      VALUES (?, ?, ?, date('now'), '08:00:00', 'B Depot', 'B Site', 500, 510, 10)
    `).run(uuid(), b.vehicleId, b.driverId);

    const { status, body } = await api("/trips", { token: a.token });
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    // None of A's rows belong to driver B.
    expect(body.data.every((t: any) => t.driver_id === a.driverId)).toBe(true);
  });

  it("cannot read another driver's trip through the listing", async () => {
    const { body } = await api("/trips", { token: b.token });
    expect(body.data.every((t: any) => t.driver_id === b.driverId)).toBe(true);
  });

  it("rejects ending a trip that belongs to another driver", async () => {
    const foreignTripId = uuid();
    db.prepare(`
      INSERT INTO vehicle_trips (id, vehicle_id, driver_id, date, time_out, start_location, destination, begin_odometer, end_odometer, total_km)
      VALUES (?, ?, ?, date('now'), '09:00:00', 'B Depot', 'B Site', 600, 600, 0)
    `).run(foreignTripId, b.vehicleId, b.driverId);

    const { status } = await api(`/trips/${foreignTripId}/end`, {
      token: a.token,
      method: "POST",
      body: { endOdometer: 620 },
    });
    expect(status).toBe(404);
  });
});

describe("Driver Portal — inspections", () => {
  it("returns the checklist definition", async () => {
    const { status, body } = await api("/inspections/checklist", { token: a.token });
    expect(status).toBe(200);
    expect(body.data.some((i: any) => i.key === "brakes")).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(14);
  });

  it("records a passing inspection", async () => {
    const { status, body } = await api("/inspections", {
      token: a.token,
      method: "POST",
      body: {
        items: [
          { key: "tyres", status: "satisfactory" },
          { key: "brakes", status: "satisfactory" },
          { key: "lights", status: "satisfactory" },
        ],
      },
    });
    expect(status).toBe(201);
    expect(body.data.result).toBe("pass");
    expect(body.data.items.length).toBe(3);
  });

  it("flags the vehicle and blocks trips when a critical defect is reported", async () => {
    const { status, body } = await api("/inspections", {
      token: b.token,
      method: "POST",
      body: { items: [{ key: "brakes", status: "defective", comment: "Pads worn through" }] },
    });
    expect(status).toBe(201);
    expect(body.data.result).toBe("fail");

    const vehicle = await api("/vehicle", { token: b.token });
    expect(vehicle.body.data.blockReason).toBeTruthy();

    const start = await api("/trips/start", {
      token: b.token,
      method: "POST",
      body: { startLocation: "Depot", destination: "Airport", beginOdometer: 1000 },
    });
    expect(start.status).toBe(409);
  });

  it("rejects unknown checklist keys", async () => {
    const { status } = await api("/inspections", {
      token: a.token,
      method: "POST",
      body: { items: [{ key: "warp_drive", status: "satisfactory" }] },
    });
    expect(status).toBe(400);
  });
});

describe("Driver Portal — fuel, faults, incidents, maintenance", () => {
  it("logs a fuel entry for the assigned vehicle", async () => {
    const { status, body } = await api("/fuel", {
      token: a.token,
      method: "POST",
      body: { station: "POM Depot", fuelType: "Diesel", litres: 40, costPerLitre: 2.5, odometerReading: 1060, receiptRef: "RCT-1" },
    });
    expect(status).toBe(201);
    expect(body.data.total_cost).toBe(100);
    expect(body.data.driver_id).toBe(a.driverId);
  });

  it("reports a fault", async () => {
    const { status, body } = await api("/faults", {
      token: a.token,
      method: "POST",
      body: { category: "electrical", description: "Headlight flickering", severity: "minor" },
    });
    expect(status).toBe(201);
    expect(body.data.driver_id).toBe(a.driverId);
  });

  it("submits an incident report", async () => {
    const { status, body } = await api("/incidents", {
      token: a.token,
      method: "POST",
      body: { incidentType: "near_miss", incidentDate: "2026-11-01", description: "Almost collided at roundabout" },
    });
    expect(status).toBe(201);
    expect(body.data.driver_id).toBe(a.driverId);
  });

  it("submits a maintenance request", async () => {
    const { status, body } = await api("/maintenance-requests", {
      token: a.token,
      method: "POST",
      body: { description: "Routine 20k service due" },
    });
    expect(status).toBe(201);
    expect(body.data.driver_id).toBe(a.driverId);
  });
});

describe("Driver Portal — leave & documents", () => {
  it("creates a leave request and lists only the driver's own", async () => {
    const { status } = await api("/leave", {
      token: a.token,
      method: "POST",
      body: { leaveType: "annual", startDate: "2026-12-01", endDate: "2026-12-05", reason: "Family" },
    });
    expect(status).toBe(201);

    const list = await api("/leave", { token: a.token });
    expect(list.body.data.every((r: any) => r.driver_id === a.driverId)).toBe(true);
  });

  it("rejects leave with end date before start date", async () => {
    const { status } = await api("/leave", {
      token: a.token,
      method: "POST",
      body: { leaveType: "sick", startDate: "2026-12-10", endDate: "2026-12-01" },
    });
    expect(status).toBe(400);
  });

  it("registers a document", async () => {
    const { status, body } = await api("/documents", {
      token: a.token,
      method: "POST",
      body: { documentType: "licence", title: "Driving Licence", fileUrl: "/uploads/abc.pdf" },
    });
    expect(status).toBe(201);
    expect(body.data.driver_id).toBe(a.driverId);
  });
});

describe("Driver Portal — safety, dashboard & notifications", () => {
  it("returns safety data derived from recorded driver events only", async () => {
    db.prepare(`
      INSERT INTO driver_events (id, event_type, driver_id, recorded_at, value)
      VALUES (?, 'speeding', ?, datetime('now'), 70)
    `).run(uuid(), a.driverId);

    const { status, body } = await api("/safety", { token: a.token });
    expect(status).toBe(200);
    expect(body.data.speedingCount).toBeGreaterThanOrEqual(1);
    expect(body.data.safetyScore).toBeLessThan(100);
  });

  it("returns a dashboard payload for the driver", async () => {
    const { status, body } = await api("/dashboard", { token: a.token });
    expect(status).toBe(200);
    expect(body.data.assignedVehicle.id).toBe(a.vehicleId);
    expect(body.data.metrics).toBeDefined();
  });

  it("scopes notifications to the authenticated user and marks them read", async () => {
    const notifId = uuid();
    db.prepare(`
      INSERT INTO driver_notifications (id, user_id, title, body, category, is_read)
      VALUES (?, ?, 'Hello', 'Body', 'general', 0)
    `).run(notifId, a.userId);

    const list = await api("/notifications", { token: a.token });
    expect(list.body.data.some((n: any) => n.id === notifId)).toBe(true);

    const read = await api(`/notifications/${notifId}/read`, { token: a.token, method: "POST" });
    expect(read.status).toBe(200);
    expect(read.body.data.is_read).toBe(1);

    // Driver B cannot read a notification belonging to Driver A.
    const foreign = await api(`/notifications/${notifId}/read`, { token: b.token, method: "POST" });
    expect(foreign.status).toBe(404);
  });
});
