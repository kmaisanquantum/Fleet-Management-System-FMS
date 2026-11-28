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
  fuelLitersFromIo,
  decodeIoFeatures,
  loadIoFeatureMap,
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

    // Deterministic fuel-counter scaling for the IO-only fuel fallback test
    // (IO 12/13 report millilitres -> 0.001 = litres). Remove any pre-existing
    // fuel rows (including legacy feature_key names) so the map is unambiguous.
    db.prepare("DELETE FROM io_feature_map WHERE io_id IN (12, 13)").run();
    db.prepare(`INSERT INTO io_feature_map (id, io_id, feature_key, label, value_type, enabled, scale_factor)
      VALUES ('test-fuel-12', 12, 'fuel_counter', 'GNSS Fuel Counter (primary)', 'scalar', 1, 0.001)`).run();
    db.prepare(`INSERT INTO io_feature_map (id, io_id, feature_key, label, value_type, enabled, scale_factor)
      VALUES ('test-fuel-13', 13, 'fuel_counter', 'GNSS Fuel Counter (secondary)', 'scalar', 1, 0.001)`).run();

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

  it("derives fuel_liters from an IO-only fuel counter using scale_factor", async () => {
    // No fuel_liters sent — the ingest must scale raw IO 12 (8421 ml) by the
    // configured 0.001 factor and store litres, never the raw counter.
    const { status } = await post(
      "/ingest",
      { ...validPayload(imeiA, "2026-03-28T13:00:00Z"), fuel_liters: null, io: { "12": 8421 } },
      INGEST_TOKEN
    );
    expect(status).toBe(201);
    const row = db.prepare("SELECT fuel_liters FROM gps_positions WHERE imei = ? AND recorded_at = ?").get(imeiA, "2026-03-28 13:00:00") as any;
    expect(row.fuel_liters).toBeCloseTo(8.421, 3);
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

  it("ignores small fuel swings as jitter and flags large ones", async () => {
    // The last stored fix for vehicle B is 102.5 L at 12:00. A +3 L swing is
    // within the 5 L jitter window and must not raise a refuel/drain alert.
    await post(
      "/ingest",
      { ...validPayload(imeiB, "2026-03-28T13:00:00Z"), fuel_liters: 102.5 + 3 },
      INGEST_TOKEN
    );
    const jitter = db
      .prepare("SELECT * FROM fleet_exceptions WHERE vehicle_id = ? AND created_at = ? AND rule_code IN ('RULE_REFUEL_DETECTED','RULE_FUEL_DRAIN')")
      .all(vehicleBId, "2026-03-28 13:00:00");
    expect(jitter).toHaveLength(0);

    // A -30 L swing exceeds the threshold and is flagged as a drain.
    const { body } = await post(
      "/ingest",
      { ...validPayload(imeiB, "2026-03-28T14:00:00Z"), fuel_liters: 105.5 - 30 },
      INGEST_TOKEN
    );
    expect(body.alerts).toBeGreaterThanOrEqual(1);
    const drain = db
      .prepare("SELECT * FROM fleet_exceptions WHERE vehicle_id = ? AND created_at = ? AND rule_code = 'RULE_FUEL_DRAIN'")
      .get(vehicleBId, "2026-03-28 14:00:00") as any;
    expect(drain).toBeDefined();
    expect(drain.type).toBe("fuel_drain");
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

  it("flags a device offline when last_seen_at is stale", async () => {
    // Prior ingests in this suite stamped last_seen_at, so the vehicle is online.
    const fresh = await get("/latest", adminToken);
    const online = fresh.body.data.find((v: any) => v.vehicle_id === vehicleAId);
    expect(online.last_seen_at).toBeTruthy();
    expect(online.online).toBe(true);

    // Backdating last_seen_at beyond the 15-minute window flips it offline.
    db.prepare("UPDATE vehicles SET last_seen_at = datetime('now', '-30 minutes') WHERE id = ?").run(vehicleAId);
    const stale = await get("/latest", adminToken);
    const offline = stale.body.data.find((v: any) => v.vehicle_id === vehicleAId);
    expect(offline.online).toBe(false);
    expect(offline.last_seen_at).toBeTruthy();

    // The device-features endpoint exposes the same status.
    const features = await get(`/features/${imeiA}`, adminToken);
    expect(features.body.data.online).toBe(false);
    expect(features.body.data.last_seen_at).toBeTruthy();
  });

  it("falls back to the last GPS fix when last_seen_at is missing", async () => {
    db.prepare("UPDATE vehicles SET last_seen_at = NULL, last_gps_fix_at = datetime('now') WHERE id = ?").run(vehicleAId);
    const { body } = await get("/latest", adminToken);
    const row = body.data.find((v: any) => v.vehicle_id === vehicleAId);
    expect(row.last_seen_at).toBeTruthy();
    expect(row.online).toBe(true);
    expect(row.imei).toBe(imeiA);
    db.prepare("UPDATE vehicles SET last_seen_at = datetime('now', '-30 minutes') WHERE id = ?").run(vehicleAId);
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
    // The raw counter is also exposed scaled into litres (0.001)
    expect(fuelFeature.scale_factor).toBeCloseTo(0.001, 6);
    expect(fuelFeature.scaled_value).toBeCloseTo(8.421, 3);
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

  /* ------------------ ingest normalization ------------------ */

  it("normalizes FMB125 IO 66/67/16/240/78 onto the telemetry record", async () => {
    const { status } = await post(
      "/ingest",
      {
        ...validPayload(imeiA, "2026-03-28T15:00:00Z"),
        // No explicit fuel_liters/odometer: the scaled IO values must drive them.
        odometer: undefined,
        io: { "255": 0, "12": 51300, "16": 123456, "66": 12400, "67": 4100, "239": 1, "240": 1, "78": 98765 },
      },
      INGEST_TOKEN
    );
    expect(status).toBe(201);

    const row = db.prepare("SELECT * FROM telemetry_records WHERE imei = ? AND recorded_at = ?").get(imeiA, "2026-03-28 15:00:00") as any;
    expect(row.ext_voltage_v).toBeCloseTo(12.4, 3);
    expect(row.int_battery_v).toBeCloseTo(4.1, 3);
    expect(row.odometer_km).toBeCloseTo(123.456, 3);
    expect(row.movement).toBe(1);
    expect(row.driver_id).toBe("98765");
    // The raw IO payload is preserved verbatim alongside the derived values.
    expect(row.io_json).toContain("12400");

    // The device features endpoint surfaces the same normalized live values.
    const { body } = await get(`/features/${imeiA}`, adminToken);
    expect(body.data.live.ext_voltage_v).toBeCloseTo(12.4, 3);
    expect(body.data.live.int_battery_v).toBeCloseTo(4.1, 3);
    expect(body.data.live.odometer_km).toBeCloseTo(123.456, 3);
    expect(body.data.live.movement).toBe(1);
    expect(body.data.live.driver_id).toBe("98765");
  });

  it("stores null (never a bogus 0) when a normalized IO element is absent", async () => {
    const { status } = await post(
      "/ingest",
      { ...validPayload(imeiA, "2026-03-28T15:30:00Z"), odometer: null, io: { "239": 1 } },
      INGEST_TOKEN
    );
    expect(status).toBe(201);
    const row = db.prepare("SELECT * FROM telemetry_records WHERE imei = ? AND recorded_at = ?").get(imeiA, "2026-03-28 15:30:00") as any;
    expect(row.ext_voltage_v).toBeNull();
    expect(row.int_battery_v).toBeNull();
    expect(row.odometer_km).toBeNull();
    expect(row.movement).toBeNull();
    expect(row.driver_id).toBeNull();
  });

  it("exposes the device profile (model + capabilities) on the features endpoint", async () => {
    const caps = { has_fuel_rs232: true, has_can_j1939: false, has_ble_sensors: true, has_camera: true, dout_count: 2 };
    db.prepare("UPDATE gps_devices SET device_model = 'FMB125', capabilities = ? WHERE device_identifier = ?")
      .run(JSON.stringify(caps), imeiA);

    const { status, body } = await get(`/features/${imeiA}`, adminToken);
    expect(status).toBe(200);
    expect(body.data.device_model).toBe("FMB125");
    expect(body.data.capabilities).toMatchObject(caps);
    expect(body.data.device_last_seen_at).toBeTruthy();
  });

  /* -------------------- media endpoints --------------------- */

  const mediaPayload = (imei: string, capturedAt = "2026-03-28T15:00:00Z") => ({
    imei,
    trigger_type: "camreq",
    camera_channel: 1,
    media_type: "image/jpeg",
    storage_url: "https://media.dspng.tech/veh-a/photo-1.jpg",
    captured_at: capturedAt,
    metadata: { source: "test" },
  });

  it("rejects a media POST without the ingest token", async () => {
    const { status, body } = await post("/media", mediaPayload(imeiA));
    expect(status).toBe(401);
    expect(body.error).toMatch(/bearer/i);
  });

  it("rejects an invalid media payload", async () => {
    const { status } = await post("/media", { imei: imeiA, trigger_type: "camreq" }, INGEST_TOKEN);
    expect(status).toBe(400);

    // Unparseable captured_at is rejected too.
    const bad = await post("/media", { ...mediaPayload(imeiA), captured_at: "not-a-date" }, INGEST_TOKEN);
    expect(bad.status).toBe(400);
  });

  it("returns 404 for media on an unregistered IMEI and 400 for an unbound device", async () => {
    expect((await post("/media", mediaPayload("000000000000000"), INGEST_TOKEN)).status).toBe(404);
    expect((await post("/media", mediaPayload(unboundImei), INGEST_TOKEN)).status).toBe(400);
  });

  it("records a media capture and resolves device -> vehicle/client", async () => {
    const { status, body } = await post("/media", mediaPayload(imeiA, "2026-03-28T15:05:00Z"), INGEST_TOKEN);
    expect(status).toBe(201);
    expect(body.data.vehicle_id).toBe(vehicleAId);
    expect(body.data.client_id).toBe(clientAId);
    expect(body.data.trigger_type).toBe("camreq");
    expect(body.data.camera_channel).toBe(1);
    expect(body.data.media_type).toBe("image/jpeg");
    expect(body.data.storage_url).toBe("https://media.dspng.tech/veh-a/photo-1.jpg");
    expect(body.data.captured_at).toBe("2026-03-28 15:05:00");
    expect(body.data.metadata_json).toContain("test");
  });

  it("scopes GET /media to the caller's client", async () => {
    // A capture on client B's device (admin-scoped read below must see both).
    await post("/media", { ...mediaPayload(imeiB, "2026-03-28T15:06:00Z"), storage_url: "https://media.dspng.tech/veh-b/photo-1.jpg" }, INGEST_TOKEN);

    const client = await get("/media", clientAToken);
    expect(client.status).toBe(200);
    expect(client.body.data.length).toBeGreaterThan(0);
    expect(client.body.data.every((m: any) => m.client_id === clientAId)).toBe(true);
    expect(client.body.data.some((m: any) => m.vehicle_id === vehicleBId)).toBe(false);

    // Filtering by client B's IMEI still returns nothing for client A.
    const filtered = await get(`/media?imei=${imeiB}`, clientAToken);
    expect(filtered.body.data.length).toBe(0);

    const admin = await get("/media", adminToken);
    expect(admin.body.data.some((m: any) => m.vehicle_id === vehicleAId)).toBe(true);
    expect(admin.body.data.some((m: any) => m.vehicle_id === vehicleBId)).toBe(true);

    // IMEI filter narrows to the requested device.
    const byImei = await get(`/media?imei=${imeiA}`, adminToken);
    expect(byImei.body.data.every((m: any) => m.vehicle_id === vehicleAId)).toBe(true);
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

  it("ignores fuel deltas below the configured threshold (jitter filtering)", () => {
    // Default threshold is 5 L: 4 L of movement is noise, 5 L is a real event.
    expect(detectFuelDelta(50, 54)).toBeNull();
    expect(detectFuelDelta(50, 55)).toBe("refuel");
    expect(detectFuelDelta(50, 46)).toBeNull();
    expect(detectFuelDelta(50, 45)).toBe("drain");

    // The thresholds are env-driven and read at call time.
    process.env.FUEL_REFUEL_MIN_L = "10";
    process.env.FUEL_DRAIN_MIN_L = "8";
    try {
      expect(detectFuelDelta(50, 57)).toBeNull();
      expect(detectFuelDelta(50, 60)).toBe("refuel");
      expect(detectFuelDelta(50, 43)).toBeNull();
      expect(detectFuelDelta(50, 42)).toBe("drain");
    } finally {
      delete process.env.FUEL_REFUEL_MIN_L;
      delete process.env.FUEL_DRAIN_MIN_L;
    }
  });

  it("normalizes FMB125 IO elements into engineering units", () => {
    const map = loadIoFeatureMap();
    const byId = (id: number) => map.find((f) => f.io_id === id);
    expect(byId(66)).toMatchObject({ feature_key: "external_voltage", value_type: "scalar", scale_factor: 0.001 });
    expect(byId(67)).toMatchObject({ feature_key: "internal_battery", value_type: "scalar", scale_factor: 0.001 });
    expect(byId(16)).toMatchObject({ feature_key: "odometer", value_type: "scalar", scale_factor: 0.001 });
    expect(byId(239)).toMatchObject({ feature_key: "ignition", value_type: "boolean" });
    expect(byId(240)).toMatchObject({ feature_key: "movement", value_type: "boolean" });

    const decoded = decodeIoFeatures({ "66": 12400, "67": 3900, "16": 123456, "240": 1 });
    expect(decoded.find((f) => f.io_id === 66)?.scaled_value).toBeCloseTo(12.4, 3);
    expect(decoded.find((f) => f.io_id === 67)?.scaled_value).toBeCloseTo(3.9, 3);
    expect(decoded.find((f) => f.io_id === 16)?.scaled_value).toBeCloseTo(123.456, 3);
    expect(decoded.find((f) => f.io_id === 240)?.scaled_value).toBe(1);
  });

  it("flags a main-power cut from a low external voltage (IO 66)", () => {
    const cut = interpretIoAlerts({ "66": 0 });
    expect(cut.find((a) => a.ruleCode === "RULE_MAIN_POWER_CUT")?.type).toBe("power_unplug");
    // A healthy external voltage produces no alert.
    expect(interpretIoAlerts({ "66": 12400 })).toHaveLength(0);
  });

  it("scales a raw fuel counter into litres via scale_factor", () => {
    const rows = [{ io_id: 12, scale_factor: 0.001 }];
    expect(fuelLitersFromIo({ "12": 51300 }, rows)).toBeCloseTo(51.3, 3);
    // Falls back to the secondary counter when the primary is absent
    expect(fuelLitersFromIo({ "13": 42000 }, [{ io_id: 12, scale_factor: 0.001 }, { io_id: 13, scale_factor: 0.001 }])).toBeCloseTo(42, 3);
    // No fuel counter present -> null (never a raw counter value)
    expect(fuelLitersFromIo({ "239": 1 }, rows)).toBeNull();
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
