import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { signAccessToken, AuthUser } from "../middleware/auth";
import deviceCommandsRouter, { buildCommand, serializeCommand } from "./deviceCommands";

/**
 * Device-command (Teltonika Codec 12) route tests.
 *
 * The router is mounted on a throwaway Express app so the tests exercise the
 * real middleware chain (JWT auth, role gate, client-scope check, zod payload
 * validation) and the MeshSat forward call (fetch mocked).
 */

/** Bearer token the VPS uses to call POST /api/telemetry/commands/ack. */
const INGEST_TOKEN = "test-ingest-token-cmd";

let server: Server;
let baseUrl: string;

let clientAId: string;
let clientBId: string;
let vehicleAId: string;
let vehicleBId: string;
let vehicleMovingId: string;
let vehicleSlowId: string;
let imeiA: string;
let imeiB: string;
let imeiMoving: string;
let imeiSlow: string;

let adminToken: string;
let fleetManagerBToken: string;
let fleetAdminToken: string;
let clientAToken: string;

let fleetManagerBUser: AuthUser;

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
  const data: any = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

/** Minimal Response-like object for the mocked fetch. */
function fakeResponse(ok: boolean, status: number, body = "{}") {
  return { ok, status, text: async () => body } as unknown as Response;
}

/** Real fetch, captured before any stub, so the test HTTP client still works. */
const realFetch = globalThis.fetch;

/**
 * Stubs the global fetch so only the route's command-endpoint forward
 * (`.../api/cmd`) is intercepted; the test client's own requests fall through
 * to the real fetch. Returns the mock so callers can assert on it.
 */
function stubRelay(impl: (url: any, opts: any) => Promise<Response> | Response) {
  const relayMock = vi.fn(impl);
  vi.stubGlobal("fetch", (url: any, opts?: any) => {
    if (String(url).includes("/api/cmd")) return relayMock(url, opts);
    return realFetch(url, opts);
  });
  return relayMock;
}

describe("Device commands router", () => {
  beforeAll(async () => {
    initSchema();

    // Configure the command endpoint contract (read lazily by forwardCommand).
    process.env.MESHSAT_CMD_URL = "https://meshsat.test";
    process.env.MESHSAT_CMD_TOKEN = "test-cmd-secret";
    // Bearer token the VPS uses for the tracker-reply callback (POST /ack).
    process.env.TELEMETRY_INGEST_TOKEN = INGEST_TOKEN;

    const s = uuid().substring(0, 8);

    clientAId = uuid();
    clientBId = uuid();
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientAId, `Cmd Client A ${s}`);
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientBId, `Cmd Client B ${s}`);

    vehicleAId = uuid();
    vehicleBId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Toyota', 'Hilux', 'Utility', 'Diesel', 'Ops', ?, 'active')
    `).run(vehicleAId, `CMD-VA-${s}`, `CMD-RA-${s}`, clientAId);
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Ford', 'Ranger', 'Utility', 'Diesel', 'Ops', ?, 'active')
    `).run(vehicleBId, `CMD-VB-${s}`, `CMD-RB-${s}`, clientBId);

    imeiA = `35401999${s}`;
    imeiB = `35401888${s}`;
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, client_id, status) VALUES (?, ?, ?, 'teltonika', ?, 'active')")
      .run(uuid(), vehicleAId, imeiA, clientAId);
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, client_id, status) VALUES (?, ?, ?, 'teltonika', ?, 'active')")
      .run(uuid(), vehicleBId, imeiB, clientBId);

    // Moving / slow vehicles for the ignition-cut speed guard. The guard reads
    // the vehicle's most recent reported speed from `telemetry_records`.
    vehicleMovingId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Isuzu', 'D-Max', 'Utility', 'Diesel', 'Ops', ?, 'active')
    `).run(vehicleMovingId, `CMD-VM-${s}`, `CMD-RM-${s}`, clientAId);
    imeiMoving = `35401777${s}`;
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, client_id, status) VALUES (?, ?, ?, 'teltonika', ?, 'active')")
      .run(uuid(), vehicleMovingId, imeiMoving, clientAId);
    db.prepare("INSERT INTO telemetry_records (id, imei, vehicle_id, recorded_at, speed_kmh) VALUES (?, ?, ?, datetime('now'), 60)")
      .run(uuid(), imeiMoving, vehicleMovingId);

    vehicleSlowId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Isuzu', 'D-Max', 'Utility', 'Diesel', 'Ops', ?, 'active')
    `).run(vehicleSlowId, `CMD-VS-${s}`, `CMD-RS-${s}`, clientAId);
    imeiSlow = `35401666${s}`;
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, client_id, status) VALUES (?, ?, ?, 'teltonika', ?, 'active')")
      .run(uuid(), vehicleSlowId, imeiSlow, clientAId);
    // Exactly at the limit: the guard blocks only speeds strictly above 10 km/h.
    db.prepare("INSERT INTO telemetry_records (id, imei, vehicle_id, recorded_at, speed_kmh) VALUES (?, ?, ?, datetime('now'), 10)")
      .run(uuid(), imeiSlow, vehicleSlowId);

    // Roles + users (audit_logs FK requires real user rows)
    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'admin', ?)").run(uuid(), "Admin");
    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'fleet_admin', ?)").run(uuid(), "Fleet Admin");
    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'fleet_manager', ?)").run(uuid(), "Fleet Manager");
    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'client_user', ?)").run(uuid(), "Client Portal User");
    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: string };
    const fleetAdminRole = db.prepare("SELECT id FROM roles WHERE name = 'fleet_admin'").get() as { id: string };
    const fmRole = db.prepare("SELECT id FROM roles WHERE name = 'fleet_manager'").get() as { id: string };
    const clientRole = db.prepare("SELECT id FROM roles WHERE name = 'client_user'").get() as { id: string };

    const adminId = uuid();
    const fleetAdminId = uuid();
    const fmBId = uuid();
    const clientId = uuid();
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', ?, ?, 'active')")
      .run(adminId, `cmd_admin_${s}@dspng.tech`, "Cmd Admin", adminRole.id);
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', ?, ?, 'active')")
      .run(fleetAdminId, `cmd_fa_${s}@dspng.tech`, "Cmd Fleet Admin", fleetAdminRole.id);
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', ?, ?, 'active')")
      .run(fmBId, `cmd_fmb_${s}@dspng.tech`, "Cmd FM B", fmRole.id);
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', ?, ?, 'active')")
      .run(clientId, `cmd_client_${s}@dspng.tech`, "Cmd Client", clientRole.id);
    // Fleet manager scoped to client B; client user scoped to client A
    db.prepare("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)").run(fmBId, clientBId);
    db.prepare("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)").run(clientId, clientAId);

    const adminUser: AuthUser = { id: adminId, email: "admin@test", roleName: "admin", airportId: null, clientIds: [clientAId, clientBId] };
    const fleetAdminUser: AuthUser = { id: fleetAdminId, email: "fa@test", roleName: "fleet_admin", airportId: null, clientIds: [] };
    fleetManagerBUser = { id: fmBId, email: "fm@test", roleName: "fleet_manager", airportId: null, clientIds: [clientBId] };
    const clientAUser: AuthUser = { id: clientId, email: "client@test", roleName: "client_user", airportId: null, clientIds: [clientAId] };

    adminToken = signAccessToken(adminUser);
    fleetAdminToken = signAccessToken(fleetAdminUser);
    fleetManagerBToken = signAccessToken(fleetManagerBUser);
    clientAToken = signAccessToken(clientAUser);

    // Deterministic parameter mapping for setparam tests
    db.prepare("INSERT OR IGNORE INTO param_map (id, feature_key, param_id, description) VALUES (?, 'test_speed_threshold', 1580, 'Test speed threshold')")
      .run(uuid());

    const app = express();
    app.use(express.json());
    app.use("/api/telemetry/commands", deviceCommandsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/telemetry/commands`;
  });

  afterAll(async () => {
    delete process.env.TELEMETRY_INGEST_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /* -------------------------- auth + roles -------------------------- */

  it("rejects an unauthenticated request", async () => {
    const { status } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 } });
    expect(status).toBe(401);
  });

  it("forbids the client_user role", async () => {
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 } }, clientAToken);
    expect(status).toBe(403);
    expect(body.error).toMatch(/role/i);
  });

  it("forbids the fleet_admin role (only admin and fleet_manager may command)", async () => {
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 } }, fleetAdminToken);
    expect(status).toBe(403);
    expect(body.error).toMatch(/role/i);
  });

  it("allows a fleet_manager (fleet-wide role) to command any client's device", async () => {
    stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 }, reason: "fleet_manager test" }, fleetManagerBToken);
    expect(status).toBe(201);
  });

  /* -------------------------- validation ---------------------------- */

  it("rejects an unsupported command type", async () => {
    const { status } = await post("/", { imei: imeiA, type: "reboot", params: {} }, adminToken);
    expect(status).toBe(400);
  });

  it("rejects setparam without a resolvable parameter", async () => {
    const { status, body } = await post("/", { imei: imeiA, type: "setparam", params: { feature_key: "nope", value: 5 } }, adminToken);
    expect(status).toBe(400);
    expect(body.details).toMatch(/unknown parameter/i);
  });

  it("rejects setdigout with an invalid DOUT state", async () => {
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 7 } }, adminToken);
    expect(status).toBe(400);
    expect(body.details).toMatch(/0 or 1/i);
  });

  it("returns 404 for an unknown IMEI", async () => {
    const { status } = await post("/", { imei: "000000000000000", type: "setdigout", params: { dout: 1 } }, adminToken);
    expect(status).toBe(404);
  });

  /* ------------------------- successful queue ----------------------- */

  it("queues a setparam command and marks it sent when the relay accepts it", async () => {
    const relay = stubRelay(() => fakeResponse(true, 202, '{"status":"queued"}'));

    const { status, body } = await post(
      "/",
      { imei: imeiA, type: "setparam", params: { feature_key: "test_speed_threshold", value: 80 } },
      adminToken
    );
    expect(status).toBe(201);
    expect(body.message).toBe("Queued / Pending Next Tracker Sync");
    expect(body.data.status).toBe("sent");
    expect(body.data.command_type).toBe("setparam");
    expect(body.data.sent_at).toBeTruthy();

    // Forwarded to the VPS command endpoint with the Bearer token and the
    // { imei, command } payload contract (command is a Teltonika string).
    expect(relay).toHaveBeenCalledTimes(1);
    const [url, opts] = relay.mock.calls[0];
    expect(String(url)).toBe("https://meshsat.test/api/cmd");
    expect((opts as any).headers.Authorization).toBe("Bearer test-cmd-secret");
    const sent = JSON.parse((opts as any).body);
    expect(sent.imei).toBe(imeiA);
    expect(sent.command).toBe("setparam 1580:80");
    expect(sent.cmd).toBeUndefined();

    // Persisted + audited
    const row = db.prepare("SELECT * FROM device_commands WHERE id = ?").get(body.data.id) as any;
    expect(row.status).toBe("sent");
    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'DEVICE_COMMAND_QUEUED' AND entity_id = ?").get(body.data.id);
    expect(audit).toBeDefined();
  });

  it("marks a command failed when the relay rejects it", async () => {
    stubRelay(() => fakeResponse(false, 500, '{"error":"boom"}'));
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 }, reason: "relay reject test" }, adminToken);
    expect(status).toBe(201);
    expect(body.data.status).toBe("failed");
    expect(body.data.response_text).toContain("boom");
  });

  it("marks a command failed when the command endpoint is unreachable", async () => {
    stubRelay(() => Promise.reject(new Error("ECONNREFUSED")));
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 0 } }, adminToken);
    expect(status).toBe(201);
    expect(body.data.status).toBe("failed");
    expect(body.data.response_text).toMatch(/unreachable/i);
  });

  /* ------------------------- immobilizer audit ---------------------- */

  it("audits ignition cut as IGNITION_CUT_QUEUED with the serialized command", async () => {
    stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 }, reason: "audit cut test" }, adminToken);
    expect(status).toBe(201);

    const audit = db
      .prepare("SELECT * FROM audit_logs WHERE action = 'IGNITION_CUT_QUEUED' AND entity_id = ?")
      .get(body.data.id) as any;
    expect(audit).toBeDefined();
    const newValue = JSON.parse(audit.new_value);
    expect(newValue.imei).toBe(imeiA);
    expect(newValue.vehicle_id).toBe(vehicleAId);
    // setdigout is serialized in the full `setdigout <dout> <index>` form (default DOUT 1).
    expect(newValue.command).toBe("setdigout 1 1");
    // The operator-supplied justification is persisted on the row + the audit.
    expect(newValue.reason).toBe("audit cut test");
    const row = db.prepare("SELECT reason FROM device_commands WHERE id = ?").get(body.data.id) as any;
    expect(row.reason).toBe("audit cut test");

    // Only the immobilizer action is written for this row, not the generic one.
    const generic = db
      .prepare("SELECT * FROM audit_logs WHERE action = 'DEVICE_COMMAND_QUEUED' AND entity_id = ?")
      .get(body.data.id);
    expect(generic).toBeUndefined();
  });

  it("audits ignition restore as IGNITION_RESTORE_QUEUED", async () => {
    stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 0 } }, adminToken);
    expect(status).toBe(201);

    const audit = db
      .prepare("SELECT * FROM audit_logs WHERE action = 'IGNITION_RESTORE_QUEUED' AND entity_id = ?")
      .get(body.data.id) as any;
    expect(audit).toBeDefined();
    expect(JSON.parse(audit.new_value).command).toBe("setdigout 0 1");
  });

  it("serializes an optional setdigout timeout (setdigout <dout> <index> <timeout>)", async () => {
    const relay = stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status } = await post(
      "/",
      { imei: imeiA, type: "setdigout", params: { dout: 1, timeout: 30 }, reason: "timeout test" },
      adminToken
    );
    expect(status).toBe(201);
    const sent = JSON.parse((relay.mock.calls[0][1] as any).body);
    expect(sent.command).toBe("setdigout 1 1 30");
  });

  it("targets a specific DOUT relay when dout_index is supplied", async () => {
    const relay = stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status } = await post(
      "/",
      { imei: imeiA, type: "setdigout", params: { dout: 1, dout_index: 2 }, reason: "dout index test" },
      adminToken
    );
    expect(status).toBe(201);
    const sent = JSON.parse((relay.mock.calls[0][1] as any).body);
    expect(sent.command).toBe("setdigout 1 2");
  });

  /* --------------------- ignition-cut safety guard ------------------ */

  it("rejects an ignition cut without a reason (400)", async () => {
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 } }, adminToken);
    expect(status).toBe(400);
    expect(body.error).toMatch(/reason/i);
  });

  it("blocks an ignition cut while the vehicle is moving (409)", async () => {
    const { status, body } = await post(
      "/",
      { imei: imeiMoving, type: "setdigout", params: { dout: 1 }, reason: "guard test" },
      adminToken
    );
    expect(status).toBe(409);
    expect(body.error).toMatch(/moving/i);
    expect(body.speed_kmh).toBe(60);
  });

  it("allows an ignition cut at or below the speed limit", async () => {
    stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post(
      "/",
      { imei: imeiSlow, type: "setdigout", params: { dout: 1 }, reason: "stationary stop" },
      adminToken
    );
    expect(status).toBe(201);
    expect(body.data.status).toBe("sent");
  });

  it("forbids a non-admin from forcing past the moving guard", async () => {
    const { status, body } = await post(
      "/",
      { imei: imeiMoving, type: "setdigout", params: { dout: 1 }, reason: "fm force attempt", force: true },
      fleetManagerBToken
    );
    expect(status).toBe(409);
    expect(body.speed_kmh).toBe(60);
  });

  it("lets an admin force an ignition cut past the guard, audited as IGNITION_CUT_FORCED", async () => {
    stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post(
      "/",
      { imei: imeiMoving, type: "setdigout", params: { dout: 1 }, reason: "emergency immobilisation", force: true },
      adminToken
    );
    expect(status).toBe(201);
    expect(body.data.status).toBe("sent");

    // The cut is audited as usual, and the forced override is logged distinctly
    // with the speed and reason that justified it.
    const cut = db
      .prepare("SELECT * FROM audit_logs WHERE action = 'IGNITION_CUT_QUEUED' AND entity_id = ?")
      .get(body.data.id);
    expect(cut).toBeDefined();

    const forced = db
      .prepare("SELECT * FROM audit_logs WHERE action = 'IGNITION_CUT_FORCED' AND entity_id = ?")
      .get(body.data.id) as any;
    expect(forced).toBeDefined();
    const nv = JSON.parse(forced.new_value);
    expect(nv.speed_kmh).toBe(60);
    expect(nv.reason).toBe("emergency immobilisation");
    expect(nv.forced).toBe(true);
  });

  /* -------------------------- ack callback -------------------------- */

  it("acknowledges the matching sent command from a tracker Codec 12 reply", async () => {
    // Issue a distinctive command so the ack match is unambiguous.
    stubRelay(() => fakeResponse(true, 202, "{}"));
    const issued = await post(
      "/",
      { imei: imeiA, type: "setparam", params: { feature_key: "test_speed_threshold", value: 77 } },
      adminToken
    );
    expect(issued.status).toBe(201);
    expect(issued.body.data.status).toBe("sent");

    // The VPS posts the tracker's reply, authenticated with the ingest token.
    const ack = await post("/ack", { imei: imeiA, cmd: "setparam 1580:77", reply: "OK 1580:77" }, INGEST_TOKEN);
    expect(ack.status).toBe(200);
    expect(ack.body.data.status).toBe("acknowledged");
    expect(ack.body.data.response_text).toBe("OK 1580:77");
    expect(ack.body.data.acked_at).toBeTruthy();

    const row = db.prepare("SELECT status, response_text, acked_at FROM device_commands WHERE id = ?").get(issued.body.data.id) as any;
    expect(row.status).toBe("acknowledged");
    expect(row.response_text).toBe("OK 1580:77");
    expect(row.acked_at).toBeTruthy();
  });

  it("requires the ingest bearer token for the ack callback", async () => {
    const { status } = await post("/ack", { imei: imeiA, command: "getver" });
    expect(status).toBe(401);
  });

  it("returns 404 when no sent command matches the ack", async () => {
    const { status, body } = await post("/ack", { imei: imeiA, command: "setparam 1580:999999" }, INGEST_TOKEN);
    expect(status).toBe(404);
    expect(body.error).toMatch(/no matching/i);
  });

  /* ------------------------- diagnostic type ------------------------ */

  it("queues a whitelisted diagnostic command and audits DEVICE_COMMAND_QUEUED", async () => {
    const relay = stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post(
      "/",
      { imei: imeiA, type: "diagnostic", params: { command: "getgps" } },
      adminToken
    );
    expect(status).toBe(201);
    expect(body.data.command_type).toBe("diagnostic");
    expect(JSON.parse((relay.mock.calls[0][1] as any).body).command).toBe("getgps");
    const audit = db
      .prepare("SELECT * FROM audit_logs WHERE action = 'DEVICE_COMMAND_QUEUED' AND entity_id = ?")
      .get(body.data.id);
    expect(audit).toBeDefined();
  });

  it("rejects a non-whitelisted diagnostic command", async () => {
    const { status, body } = await post(
      "/",
      { imei: imeiA, type: "diagnostic", params: { command: "reboot" } },
      adminToken
    );
    expect(status).toBe(400);
    expect(body.details).toMatch(/diagnostic/i);
  });

  it("queues a readio diagnostic command", async () => {
    const relay = stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post(
      "/",
      { imei: imeiA, type: "diagnostic", params: { command: "readio" } },
      adminToken
    );
    expect(status).toBe(201);
    expect(JSON.parse((relay.mock.calls[0][1] as any).body).command).toBe("readio");
    expect(body.data.command_type).toBe("diagnostic");
  });

  it("queues a camreq command with an optional channel", async () => {
    const relay = stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post(
      "/",
      { imei: imeiA, type: "camreq", params: { channel: 2 } },
      adminToken
    );
    expect(status).toBe(201);
    expect(body.data.command_type).toBe("camreq");
    expect(JSON.parse((relay.mock.calls[0][1] as any).body).command).toBe("camreq 2");
  });

  /* ----------------------- history + cancel ------------------------- */

  it("returns tenant-scoped command history", async () => {
    // Admin (fleet-wide) queues a command for client B's device.
    stubRelay(() => fakeResponse(true, 202, "{}"));
    await post("/", { imei: imeiB, type: "setdigout", params: { dout: 1 }, reason: "history test" }, adminToken);

    // A client_portal user (scoped to client A) may read history but only sees
    // their own client's commands, never client B's.
    const clientA = await get("/", clientAToken);
    expect(clientA.status).toBe(200);
    expect(clientA.body.data.length).toBeGreaterThan(0);
    expect(clientA.body.data.every((r: any) => r.client_id === clientAId)).toBe(true);
    expect(clientA.body.data.some((r: any) => r.imei === imeiB)).toBe(false);

    // Filtering by a client B imei still returns nothing for client A.
    const filtered = await get("/?imei=" + imeiB, clientAToken);
    expect(filtered.body.data.length).toBe(0);

    // Admin sees both clients' commands.
    const admin = await get("/", adminToken);
    expect(admin.body.data.some((r: any) => r.imei === imeiA)).toBe(true);
    expect(admin.body.data.some((r: any) => r.imei === imeiB)).toBe(true);
  });

  it("cancels a still-queued command", async () => {
    // Insert a queued row directly — with the VPS contract a forward either
    // succeeds ('sent') or fails ('failed'), so a row only stays 'queued' if
    // it is awaiting dispatch. Exercising cancel therefore needs a queued row.
    const queuedId = uuid();
    db.prepare(`
      INSERT INTO device_commands (id, imei, vehicle_id, command_type, payload_json, status, requested_by)
      VALUES (?, ?, ?, 'setdigout', ?, 'queued', NULL)
    `).run(queuedId, imeiA, vehicleAId, JSON.stringify({ type: "setdigout", dout: 1 }));

    const { status, body } = await post(`/${queuedId}/cancel`, {}, adminToken);
    expect(status).toBe(200);
    expect(body.data.status).toBe("failed");
    expect(body.data.response_text).toMatch(/cancel/i);

    // A non-queued command cannot be cancelled again
    const again = await post(`/${queuedId}/cancel`, {}, adminToken);
    expect(again.status).toBe(409);
  });

  it("forbids the client_user role from cancelling a command", async () => {
    const queuedId = uuid();
    db.prepare(`
      INSERT INTO device_commands (id, imei, vehicle_id, command_type, payload_json, status, requested_by)
      VALUES (?, ?, ?, 'setdigout', ?, 'queued', NULL)
    `).run(queuedId, imeiA, vehicleAId, JSON.stringify({ type: "setdigout", dout: 1 }));

    const { status, body } = await post(`/${queuedId}/cancel`, {}, clientAToken);
    expect(status).toBe(403);
    expect(body.error).toMatch(/role/i);
  });

  /* -------------------------- pure logic ---------------------------- */

  it("builds Codec-12 commands from validated parameters", () => {
    expect(buildCommand("setparam", { param_id: 1580, value: 90 })).toEqual({ command: { type: "setparam", param_id: 1580, value: 90 } });
    expect(buildCommand("setparam", { feature_key: "test_speed_threshold", value: 90 })).toEqual({ command: { type: "setparam", param_id: 1580, value: 90 } });
    expect(buildCommand("setparam", { feature_key: "nope", value: 1 }).error).toBeTruthy();
    expect(buildCommand("setdigout", { dout: 1 })).toEqual({ command: { type: "setdigout", dout: 1 } });
    expect(buildCommand("setdigout", { dout: 2 }).error).toBeTruthy();
    expect(buildCommand("raw", { command: "getinfo" })).toEqual({ command: { type: "raw", command: "getinfo" } });
  });

  it("accepts an optional non-negative integer setdigout timeout", () => {
    expect(buildCommand("setdigout", { dout: 1, timeout: 30 })).toEqual({ command: { type: "setdigout", dout: 1, timeout: 30 } });
    expect(buildCommand("setdigout", { dout: 1, timeout: 0 })).toEqual({ command: { type: "setdigout", dout: 1, timeout: 0 } });
    // Backward compatible: no timeout -> bare form.
    expect(buildCommand("setdigout", { dout: 0 })).toEqual({ command: { type: "setdigout", dout: 0 } });
    // Invalid timeouts are rejected.
    expect(buildCommand("setdigout", { dout: 1, timeout: -1 }).error).toBeTruthy();
    expect(buildCommand("setdigout", { dout: 1, timeout: 1.5 }).error).toBeTruthy();
  });

  it("accepts an optional positive integer setdigout dout_index", () => {
    expect(buildCommand("setdigout", { dout: 1, dout_index: 2 })).toEqual({ command: { type: "setdigout", dout: 1, dout_index: 2 } });
    // `index` is an accepted alias.
    expect(buildCommand("setdigout", { dout: 0, index: 3 })).toEqual({ command: { type: "setdigout", dout: 0, dout_index: 3 } });
    // Invalid indices are rejected.
    expect(buildCommand("setdigout", { dout: 1, dout_index: 0 }).error).toBeTruthy();
    expect(buildCommand("setdigout", { dout: 1, dout_index: -1 }).error).toBeTruthy();
    expect(buildCommand("setdigout", { dout: 1, dout_index: 1.5 }).error).toBeTruthy();
  });

  it("builds a camreq command with an optional positive channel", () => {
    expect(buildCommand("camreq", {})).toEqual({ command: { type: "camreq" } });
    expect(buildCommand("camreq", { channel: 1 })).toEqual({ command: { type: "camreq", channel: 1 } });
    expect(buildCommand("camreq", { camera_channel: 2 })).toEqual({ command: { type: "camreq", channel: 2 } });
    expect(buildCommand("camreq", { channel: 0 }).error).toBeTruthy();
    expect(buildCommand("camreq", { channel: 1.5 }).error).toBeTruthy();
  });

  it("only allows whitelisted diagnostic commands", () => {
    for (const cmd of ["getinfo", "getgps", "getver", "getstatus", "readio"]) {
      expect(buildCommand("diagnostic", { command: cmd })).toEqual({ command: { type: "diagnostic", command: cmd } });
    }
    expect(buildCommand("diagnostic", { command: "reboot" }).error).toBeTruthy();
    expect(buildCommand("diagnostic", { command: "setparam 1580:80" }).error).toBeTruthy();
    expect(buildCommand("diagnostic", {}).error).toBeTruthy();
  });

  it("serializes built commands into Teltonika command strings", () => {
    expect(serializeCommand({ type: "setparam", param_id: 1580, value: 80 })).toBe("setparam 1580:80");
    // setdigout emits the full `<dout> <index>` form (index defaults to 1).
    expect(serializeCommand({ type: "setdigout", dout: 1 })).toBe("setdigout 1 1");
    expect(serializeCommand({ type: "setdigout", dout: 1, dout_index: 2 })).toBe("setdigout 1 2");
    expect(serializeCommand({ type: "setdigout", dout: 1, timeout: 30 })).toBe("setdigout 1 1 30");
    expect(serializeCommand({ type: "setdigout", dout: 0 })).toBe("setdigout 0 1");
    expect(serializeCommand({ type: "camreq" })).toBe("camreq");
    expect(serializeCommand({ type: "camreq", channel: 2 })).toBe("camreq 2");
    expect(serializeCommand({ type: "diagnostic", command: "getver" })).toBe("getver");
    expect(serializeCommand({ type: "diagnostic", command: "readio" })).toBe("readio");
    expect(serializeCommand({ type: "raw", command: "getinfo" })).toBe("getinfo");
  });
});
