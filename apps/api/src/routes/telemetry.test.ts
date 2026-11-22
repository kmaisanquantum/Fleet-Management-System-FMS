import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { signAccessToken, AuthUser } from "../middleware/auth";
import telemetryRouter, {
  ingestSchema,
  interpretIoAlerts,
  detectFuelDelta,
  normalizeTimestamp,
} from "./telemetry";
import { resolveClientScopes } from "../utils/scope";

/**
 * Telemetry ingest + read API tests.
 *
 * The router is mounted on a throwaway Express app listening on an ephemeral
 * port so the tests exercise the real middleware chain (bearer-token auth,
 * zod validation, idempotent ingest, client-scoped reads).
 */

const INGEST_TOKEN = "test-ingest-token-abc123";

let server: Server;
let baseUrl: string;

let clientAId: string;
let clientBId: string;

let vehicleAId: string;
let vehicleBId: string;

let imeiA: string;
let imeiB: string;
let unboundImei: string;

let adminUser: AuthUser;
let clientAUser: AuthUser;

let adminToken: string;
let clientAToken: string;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const raw = await res.text();
  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }
  const isCsv = res.headers.get("content-type")?.includes("csv");
  return { status: res.status, body, text: isCsv ? raw : undefined };
}

const validPayload = (imei: string, timestamp = "2026-03-28T11:00:00Z") => ({
  imei,
  timestamp,
  lat: -9.4438,
  lon: 147.1803,
  sats: 9,
  speed_kmh: 45,
  ignition: true,
  fuel_liters: 62.5,
  io: { "239": 1, "16": 123456, "21": 4, "255": 1 },
});

describe("Telemetry router", () => {
  beforeAll(async () => {
    process.env.TELEMETRY_INGEST_TOKEN = INGEST_TOKEN;
    initSchema();

    const s = uuid().substring(0, 8);

    clientAId = uuid();
    clientBId = uuid();
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientAId, `Client A ${s}`);
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientBId, `Client B ${s}`);

    vehicleAId = uuid();
    vehicleBId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status, tank_capacity_litres)
      VALUES (?, ?, ?, 'Toyota', 'Hilux', 'Utility', 'Diesel', 'Ops', ?, 'active', 80.0)
    `).run(vehicleAId, `TEL-VA-${s}`, `TEL-RA-${s}`, clientAId);
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status, tank_capacity_litres)
      VALUES (?, ?, ?, 'Ford', 'Ranger', 'Utility', 'Diesel', 'Ops', ?, 'active', 80.0)
    `).run(vehicleBId, `TEL-VB-${s}`, `TEL-RB-${s}`, clientBId);

    imeiA = `35401811${s}`;
    imeiB = `35401812${s}`;
    unboundImei = `35401813${s}`;
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, client_id, status) VALUES (?, ?, ?, 'teltonika', ?, 'active')")
      .run(uuid(), vehicleAId, imeiA, clientAId);
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, client_id, status) VALUES (?, ?, ?, 'teltonika', ?, 'active')")
      .run(uuid(), vehicleBId, imeiB, clientBId);
    // Registered but not bound to any vehicle
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, status) VALUES (?, NULL, ?, 'teltonika', 'active')")
      .run(uuid(), unboundImei);

    // Users backing the scoped JWT callers (audit_logs FK requires the user to exist)
    const adminRoleId = uuid();
    const clientRoleId = uuid();
    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'admin', ?)").run(adminRoleId, "Admin");
    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'client_user', ?)").run(clientRoleId, "Client Portal User");
    const adminRow = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: string };
    const clientRow = db.prepare("SELECT id FROM roles WHERE name = 'client_user'").get() as { id: string };

    const adminId = uuid();
    const clientUserId = uuid();
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', 'T Admin', ?, 'active')")
      .run(adminId, `tel_admin_${s}@dspng.tech`, adminRow.id);
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', 'T Client A', ?, 'active')")
      .run(clientUserId, `tel_client_${s}@dspng.tech`, clientRow.id);
    // Client-role user -> client A via the user_clients join table
    db.prepare("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)").run(clientUserId, clientAId);

    adminUser = { id: adminId, email: "admin@test", roleName: "admin", airportId: null, clientIds: [clientAId] };
    clientAUser = { id: clientUserId, email: "client@test", roleName: "client_user", airportId: null, clientIds: [clientAId] };
    adminToken = signAccessToken(adminUser);
    clientAToken = signAccessToken(clientAUser);

    const app = express();
    app.use(express.json());
    app.use("/api/telemetry", telemetryRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/telemetry`;
  });

  afterAll(async () => {
    delete process.env.TELEMETRY_INGEST_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /* -------------------------- auth -------------------------- */

  it("rejects ingest without a bearer token", async () => {
    const { status, body } = await post("/ingest", validPayload(imeiA));
    expect(status).toBe(401);
    expect(body.error).toMatch(/bearer/i);
  });

  it("rejects ingest with an invalid ingest token", async () => {
    const { status } = await post("/ingest", validPayload(imeiA), "wrong-token");
    expect(status).toBe(401);
  });

  /* ----------------------- validation ----------------------- */

  it("rejects a payload with an invalid timestamp", async () => {
    const { status, body } = await post("/ingest", { ...validPayload(imeiA), timestamp: "not-a-date" }, INGEST_TOKEN);
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid/i);
  });

  it("rejects a payload with out-of-range coordinates", async () => {
    const { status } = await post("/ingest", { ...validPayload(imeiA), lat: 999 }, INGEST_TOKEN);
    expect(status).toBe(400);
  });

  it("rejects a payload missing required fields", async () => {
    const { status } = await post("/ingest", { imei: imeiA }, INGEST_TOKEN);
    expect(status).toBe(400);
  });

  it("returns 404 for an unregistered IMEI", async () => {
    const { status, body } = await post("/ingest", validPayload("000000000000000"), INGEST_TOKEN);
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown device/i);
  });

  it("returns 400 when the device is registered but unbound", async () => {
    const { status, body } = await post("/ingest", validPayload(unboundImei), INGEST_TOKEN);
    expect(status).toBe(400);
    expect(body.error).toMatch(/not bound/i);
  });

  /* --------------------- ingest + alerts -------------------- */

  it("ingests a valid record, stores rich fields and creates alerts", async () => {
    const ts = "2026-03-28T11:00:00Z";
    const { status, body } = await post("/ingest", validPayload(imeiA, ts), INGEST_TOKEN);
    expect(status).toBe(201);
    expect(body.alerts).toBeGreaterThanOrEqual(1);

    const row = db.prepare("SELECT * FROM gps_positions WHERE imei = ? AND recorded_at = ?").get(imeiA, "2026-03-28 11:00:00") as any;
    expect(row).toBeDefined();
    expect(row.vehicle_id).toBe(vehicleAId);
    expect(row.sats).toBe(9);
    expect(row.fuel_liters).toBeCloseTo(62.5);
    expect(row.imei).toBe(imeiA);
    expect(row.io_json).toContain("255");

    const vehicle = db.prepare("SELECT current_latitude, current_longitude, current_fuel_level_pct FROM vehicles WHERE id = ?").get(vehicleAId) as any;
    expect(vehicle.current_latitude).toBeCloseTo(-9.4438);
    expect(vehicle.current_longitude).toBeCloseTo(147.1803);
    expect(vehicle.current_fuel_level_pct).toBeCloseTo((62.5 / 80) * 100);

    // IO 255 (overspeed) must have raised a typed, source-tagged fleet exception
    const exc = db.prepare("SELECT * FROM fleet_exceptions WHERE rule_code = 'RULE_OVERSPEED' AND vehicle_id = ?").get(vehicleAId) as any;
    expect(exc).toBeDefined();
    expect(exc.type).toBe("overspeed");
    expect(exc.source).toBe("telemetry");
  });

  it("keeps the raw IO 12/13 fuel counter alongside the position", async () => {
    const { status, body } = await post(
      "/ingest",
      { ...validPayload(imeiA, "2026-03-28T11:30:00Z"), io: { "12": 8421, "239": 1 } },
      INGEST_TOKEN
    );
    expect(status).toBe(201);
    expect(body.fuelCounter).toBe(8421);
    const row = db.prepare("SELECT io_json FROM gps_positions WHERE imei = ? AND recorded_at = ?").get(imeiA, "2026-03-28 11:30:00") as any;
    expect(row.io_json).toContain("8421");
  });

  it("ignores a duplicate record and reports it (idempotent)", async () => {
    const ts = "2026-03-28T11:00:00Z";
    const before = (db.prepare("SELECT COUNT(*) AS n FROM gps_positions WHERE imei = ?").get(imeiA) as any).n;
    const { status, body } = await post("/ingest", validPayload(imeiA, ts), INGEST_TOKEN);
    expect(status).toBe(200);
    expect(body.duplicate).toBe(true);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM gps_positions WHERE imei = ?").get(imeiA) as any).n;
    expect(after).toBe(before);
  });

  it("detects a refuel from a fuel-level rise", async () => {
    // Previous stored fix for vehicle B was 62.5L at 11:00; a +40L jump is a refuel
    await post("/ingest", validPayload(imeiB, "2026-03-28T11:00:00Z"), INGEST_TOKEN);
    const { body } = await post(
      "/ingest",
      { ...validPayload(imeiB, "2026-03-28T12:00:00Z"), fuel_liters: 62.5 + 40 },
      INGEST_TOKEN
    );
    expect(body.alerts).toBeGreaterThanOrEqual(1);
    const refuel = db.prepare("SELECT * FROM fleet_exceptions WHERE rule_code = 'RULE_REFUEL_DETECTED' AND vehicle_id = ?").get(vehicleBId) as any;
    expect(refuel).toBeDefined();
  });

  /* --------------------- client scoping --------------------- */

  it("scopes GET /latest to the caller's client", async () => {
    const admin = await get("/latest", adminToken);
    expect(admin.status).toBe(200);
    expect(admin.body.data.length).toBeGreaterThanOrEqual(2);

    const client = await get("/latest", clientAToken);
    expect(client.status).toBe(200);
    expect(client.body.data.every((v: any) => v.client_id === clientAId)).toBe(true);
    expect(client.body.data.some((v: any) => v.vehicle_id === vehicleAId)).toBe(true);
  });

  it("requires auth for GET /latest", async () => {
    const { status } = await get("/latest");
    expect(status).toBe(401);
  });

  it("scopes GET /summary to the caller's client", async () => {
    const admin = await get("/summary?from=2026-03-28&to=2026-03-29", adminToken);
    expect(admin.status).toBe(200);
    const adminVehicleIds = admin.body.data.vehicles.map((v: any) => v.vehicle_id);
    expect(adminVehicleIds).toContain(vehicleAId);
    expect(adminVehicleIds).toContain(vehicleBId);

    const client = await get("/summary?from=2026-03-28&to=2026-03-29", clientAToken);
    expect(client.status).toBe(200);
    expect(client.body.data.vehicles.every((v: any) => v.client_id === clientAId)).toBe(true);
    expect(client.body.data.events.every((e: any) => e.vehicle_id !== vehicleBId)).toBe(true);
  });

  it("scopes the CSV export to the caller's client", async () => {
    const client = await get("/export?format=csv&from=2026-03-28&to=2026-03-29", clientAToken);
    expect(client.status).toBe(200);
    expect(client.text).toContain("vehicle_number");
    expect(client.text).not.toContain(`TEL-VB`);
  });

  /* ------------------- device features + records ------------------- */

  it("writes an idempotent telemetry_records row on ingest", async () => {
    const row = db.prepare("SELECT * FROM telemetry_records WHERE imei = ? AND recorded_at = ?").get(imeiA, "2026-03-28 11:00:00") as any;
    expect(row).toBeDefined();
    expect(row.vehicle_id).toBe(vehicleAId);
    // Re-sending the same fix does not create a second telemetry_records row
    const before = (db.prepare("SELECT COUNT(*) AS n FROM telemetry_records WHERE imei = ?").get(imeiA) as any).n;
    await post("/ingest", validPayload(imeiA, "2026-03-28T11:00:00Z"), INGEST_TOKEN);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM telemetry_records WHERE imei = ?").get(imeiA) as any).n;
    expect(after).toBe(before);
  });

  it("decodes IO features and recent events for a device", async () => {
    const { status, body } = await get(`/features/${imeiA}`, adminToken);
    expect(status).toBe(200);
    expect(body.data.imei).toBe(imeiA);
    expect(body.data.vehicle_id).toBe(vehicleAId);
    expect(body.data.live).toBeTruthy();
    // The IO feature list is decoded through the configurable io_feature_map
    expect(Array.isArray(body.data.features)).toBe(true);
    expect(body.data.features.length).toBeGreaterThan(0);
    const fuelFeature = body.data.features.find((f: any) => f.io_id === 12);
    expect(fuelFeature).toBeDefined();
    expect(fuelFeature.value).toBe(8421);
    // Recent telemetry events are included
    expect(body.data.events.some((e: any) => e.rule_code === "RULE_OVERSPEED")).toBe(true);
  });

  it("returns 404 for features of an unbound or unknown device", async () => {
    expect((await get(`/features/${unboundImei}`, adminToken)).status).toBe(404);
    expect((await get("/features/000000000000000", adminToken)).status).toBe(404);
  });

  it("forbids a client user from reading another client's device features", async () => {
    const { status } = await get(`/features/${imeiB}`, clientAToken);
    expect(status).toBe(403);
  });

  /* ------------------------ pure logic ---------------------- */

  it("maps truthy IO elements to alert rules with telemetry types", () => {
    const alerts = interpretIoAlerts({ "255": 1, "252": 1, "247": 1, "175": 1 });
    const rules = alerts.map((a) => a.ruleCode);
    expect(rules).toContain("RULE_OVERSPEED");
    expect(rules).toContain("RULE_DEVICE_UNPLUG");
    expect(rules).toContain("RULE_CRASH_DETECTED");
    expect(alerts.find((a) => a.ruleCode === "RULE_OVERSPEED")?.type).toBe("overspeed");
    expect(alerts.find((a) => a.ruleCode === "RULE_DEVICE_UNPLUG")?.type).toBe("power_unplug");
    expect(alerts.find((a) => a.ruleCode === "RULE_GEOFENCE_IO")?.type).toBe("geofence_entry");
    // Falsy / absent IO produces no alerts
    expect(interpretIoAlerts({ "255": 0 })).toHaveLength(0);
    expect(interpretIoAlerts({})).toHaveLength(0);
    // Scalar fuel-counter IO (12/13) never produces an alert
    expect(interpretIoAlerts({ "12": 8421, "13": 900 })).toHaveLength(0);
  });

  it("classifies fuel deltas above the threshold", () => {
    expect(detectFuelDelta(50, 60)).toBe("refuel");
    expect(detectFuelDelta(60, 50)).toBe("drain");
    expect(detectFuelDelta(50, 52)).toBeNull();
    expect(detectFuelDelta(null, 60)).toBeNull();
  });

  it("normalizes ISO timestamps and validates the ingest schema", () => {
    expect(normalizeTimestamp("2026-03-28T11:00:00Z")).toBe("2026-03-28 11:00:00");
    expect(ingestSchema.safeParse(validPayload(imeiA)).success).toBe(true);
    expect(ingestSchema.safeParse({ imei: "", timestamp: "x", lat: 0, lon: 0 }).success).toBe(false);
  });

  it("resolveClientScopes gives fleet roles full visibility and restricts client users", () => {
    expect(resolveClientScopes(adminUser)).toBeNull();
    expect(resolveClientScopes({ ...clientAUser, roleName: "fleet_manager" })).toBeNull();
    expect(resolveClientScopes(clientAUser)).toEqual([clientAId]);
    // A user mapped to two clients is scoped to both
    expect(resolveClientScopes({ ...clientAUser, clientIds: [clientAId, clientBId] })).toEqual([clientAId, clientBId]);
    // No client mapping -> unrestricted
    expect(resolveClientScopes({ ...clientAUser, clientIds: [] })).toBeNull();
    expect(resolveClientScopes(null)).toBeNull();
  });
});
