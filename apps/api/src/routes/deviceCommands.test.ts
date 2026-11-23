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

let server: Server;
let baseUrl: string;

let clientAId: string;
let clientBId: string;
let vehicleAId: string;
let vehicleBId: string;
let imeiA: string;
let imeiB: string;

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
    const { status } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 } }, fleetManagerBToken);
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
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 } }, adminToken);
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
    const { status, body } = await post("/", { imei: imeiA, type: "setdigout", params: { dout: 1 } }, adminToken);
    expect(status).toBe(201);

    const audit = db
      .prepare("SELECT * FROM audit_logs WHERE action = 'IGNITION_CUT_QUEUED' AND entity_id = ?")
      .get(body.data.id) as any;
    expect(audit).toBeDefined();
    const newValue = JSON.parse(audit.new_value);
    expect(newValue.imei).toBe(imeiA);
    expect(newValue.vehicle_id).toBe(vehicleAId);
    expect(newValue.command).toBe("setdigout 1");

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
    expect(JSON.parse(audit.new_value).command).toBe("setdigout 0");
  });

  it("serializes an optional setdigout timeout (setdigout <dout> <timeout>)", async () => {
    const relay = stubRelay(() => fakeResponse(true, 202, "{}"));
    const { status } = await post(
      "/",
      { imei: imeiA, type: "setdigout", params: { dout: 1, timeout: 30 } },
      adminToken
    );
    expect(status).toBe(201);
    const sent = JSON.parse((relay.mock.calls[0][1] as any).body);
    expect(sent.command).toBe("setdigout 1 30");
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

  /* ----------------------- history + cancel ------------------------- */

  it("returns tenant-scoped command history", async () => {
    // Admin (fleet-wide) queues a command for client B's device.
    stubRelay(() => fakeResponse(true, 202, "{}"));
    await post("/", { imei: imeiB, type: "setdigout", params: { dout: 1 } }, adminToken);

    // A client_portal user (scoped to client A) may read history but only sees
    // their own client's commands, never client B's.
    const clientA = await get("/", clientAToken);
    expect(clientA.status).toBe(200);
    expect(clientA.body.data.every((r: any) => r.imei === imeiA)).toBe(true);
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

  it("only allows whitelisted diagnostic commands", () => {
    for (const cmd of ["getinfo", "getgps", "getver", "getstatus"]) {
      expect(buildCommand("diagnostic", { command: cmd })).toEqual({ command: { type: "diagnostic", command: cmd } });
    }
    expect(buildCommand("diagnostic", { command: "reboot" }).error).toBeTruthy();
    expect(buildCommand("diagnostic", { command: "setparam 1580:80" }).error).toBeTruthy();
    expect(buildCommand("diagnostic", {}).error).toBeTruthy();
  });

  it("serializes built commands into Teltonika command strings", () => {
    expect(serializeCommand({ type: "setparam", param_id: 1580, value: 80 })).toBe("setparam 1580:80");
    expect(serializeCommand({ type: "setdigout", dout: 1 })).toBe("setdigout 1");
    expect(serializeCommand({ type: "setdigout", dout: 1, timeout: 30 })).toBe("setdigout 1 30");
    expect(serializeCommand({ type: "setdigout", dout: 0 })).toBe("setdigout 0");
    expect(serializeCommand({ type: "diagnostic", command: "getver" })).toBe("getver");
    expect(serializeCommand({ type: "raw", command: "getinfo" })).toBe("getinfo");
  });
});
