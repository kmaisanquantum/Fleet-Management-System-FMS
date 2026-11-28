import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { signAccessToken, AuthUser } from "../middleware/auth";
import deviceConfigRouter from "./deviceConfig";
import deviceCommandsRouter from "./deviceCommands";
import telemetryRouter from "./telemetry";

/**
 * Remote FMB125 configuration tests. These exercise the real Express chain
 * (JWT auth, role gate, tenant scope, zod validation), the real parameter map,
 * the SQLite config-state table, and the MeshSat gateway forward (fetch mocked).
 */

const INGEST_TOKEN = "test-ingest-token-config";

let server: Server;
let baseUrl: string;
let adminToken: string;
let clientToken: string;
let imei: string;
let imeiB: string;
let clientId: string;
let vehicleId: string;
let vehicleBId: string;

const realFetch = globalThis.fetch;

function fakeResponse(ok: boolean, status: number, body = "{}") {
  return { ok, status, text: async () => body } as unknown as Response;
}

function stubGateway(impl: (url: any, opts: any) => Promise<Response> | Response) {
  const gateway = vi.fn(impl);
  vi.stubGlobal("fetch", (url: any, opts?: any) => {
    const target = String(url);
    const isBridge = target.includes("/api/devices/") && target.endsWith("/command") && !target.includes("127.0.0.1");
    if (target.includes("/api/cmd") || isBridge) return gateway(url, opts);
    return realFetch(url, opts);
  });
  return gateway;
}

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

describe("Remote device configuration router", () => {
  beforeAll(async () => {
    initSchema();
    process.env.MESHSAT_API_URL = "https://gateway.test";
    process.env.MESHSAT_API_KEY = "test-config-key";
    process.env.TELEMETRY_INGEST_TOKEN = INGEST_TOKEN;

    const s = uuid().substring(0, 8);
    clientId = uuid();
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientId, `Config Client ${s}`);

    vehicleId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Teltonika', 'FMB125', 'Utility', 'Diesel', 'Ops', ?, 'active')
    `).run(vehicleId, `CFG-V-${s}`, `CFG-R-${s}`, clientId);

    imei = `35401555${s}`;
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, device_model, client_id, status, last_seen_at) VALUES (?, ?, ?, 'teltonika', 'FMB125', ?, 'active', datetime('now'))")
      .run(uuid(), vehicleId, imei, clientId);

    vehicleBId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Teltonika', 'FMB125', 'Utility', 'Diesel', 'Ops', ?, 'active')
    `).run(vehicleBId, `CFG-VB-${s}`, `CFG-RB-${s}`, clientId);

    imeiB = `35401444${s}`;
    db.prepare("INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, device_model, client_id, status, last_seen_at) VALUES (?, ?, ?, 'teltonika', 'FMB125', ?, 'active', datetime('now'))")
      .run(uuid(), vehicleBId, imeiB, clientId);

    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'admin', 'Admin')").run(uuid());
    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'client_user', 'Client')").run(uuid());
    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: string };
    const clientRole = db.prepare("SELECT id FROM roles WHERE name = 'client_user'").get() as { id: string };
    const adminId = uuid();
    const clientUserId = uuid();
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', ?, ?, 'active')")
      .run(adminId, `cfg_admin_${s}@dspng.tech`, "Config Admin", adminRole.id);
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', ?, ?, 'active')")
      .run(clientUserId, `cfg_client_${s}@dspng.tech`, "Config Client", clientRole.id);
    db.prepare("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)").run(clientUserId, clientId);

    const adminUser: AuthUser = { id: adminId, email: "cfg-admin@test", roleName: "admin", airportId: null, clientIds: [] };
    const clientUser: AuthUser = { id: clientUserId, email: "cfg-client@test", roleName: "client_user", airportId: null, clientIds: [clientId] };
    adminToken = signAccessToken(adminUser);
    clientToken = signAccessToken(clientUser);

    const app = express();
    app.use(express.json());
    app.use("/api/devices", deviceConfigRouter);
    app.use("/api/telemetry/commands", deviceCommandsRouter);
    app.use("/api/telemetry", telemetryRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    delete process.env.MESHSAT_API_URL;
    delete process.env.MESHSAT_API_KEY;
    delete process.env.TELEMETRY_INGEST_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    delete process.env.MESHSAT_BRIDGE_URL;
    delete process.env.MESHSAT_BRIDGE_TOKEN;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires authentication for the config view", async () => {
    const { status } = await get(`/api/devices/${imei}/config`);
    expect(status).toBe(401);
  });

  it("forbids the client_user role from changing configuration", async () => {
    const { status } = await post(`/api/devices/${imei}/config`, { parameters: [{ param_id: 1580, value: 80 }] }, clientToken);
    expect(status).toBe(403);
  });

  it("returns mapped parameters and presets for the device", async () => {
    const { status, body } = await get(`/api/devices/${imei}/config`, adminToken);
    expect(status).toBe(200);
    expect(body.data.imei).toBe(imei);
    expect(body.data.presets.map((p: any) => p.key)).toEqual(
      expect.arrayContaining(["reporting_interval", "ignition_source", "data_acquisition", "digital_output_control"])
    );
    const reporting = body.data.parameters.find((p: any) => p.feature_key === "reporting_interval");
    expect(reporting.param_id).toBe(100);
    expect(reporting.status).toBe("unknown");
  });

  it("queues a raw parameter write through the MeshSat gateway", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post(
      `/api/devices/${imei}/config`,
      { parameters: [{ param_id: 1580, value: 80 }], reason: "test raw write" },
      adminToken
    );
    expect(status).toBe(201);
    expect(body.data.results[0].command).toBe("setparam 1580:80");
    expect(gateway).toHaveBeenCalledTimes(1);
    const [url, opts] = gateway.mock.calls[0];
    expect(String(url)).toBe("https://gateway.test/api/cmd");
    expect((opts as any).headers.Authorization).toBe("Bearer test-config-key");

    const state = db
      .prepare("SELECT * FROM device_config_state WHERE imei = ? AND param_id = 1580")
      .get(imei) as any;
    expect(state.status).toBe("pending");
    expect(state.value).toBe("80");
  });

  it("resolves the reporting_interval preset through the parameter map", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));
    const { status } = await post(
      `/api/devices/${imei}/config`,
      { preset: "reporting_interval", value: 30 },
      adminToken
    );
    expect(status).toBe(201);
    expect(JSON.parse((gateway.mock.calls[0][1] as any).body).command).toBe("setparam 100:30");
  });

  it("expands the data_acquisition preset into ignition-on and ignition-off writes", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));
    const { status } = await post(
      `/api/devices/${imei}/config`,
      { preset: "data_acquisition", values: { ignition_on: 10, ignition_off: 60 } },
      adminToken
    );
    expect(status).toBe(201);
    const commands = gateway.mock.calls.map((c) => JSON.parse((c[1] as any).body).command);
    expect(commands).toEqual(expect.arrayContaining(["setparam 104:10", "setparam 102:60"]));
  });

  it("queues read-only getparam commands", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));
    const { status } = await post(
      `/api/devices/${imei}/config`,
      { read: [1580, "reporting_interval"] },
      adminToken
    );
    expect(status).toBe(201);
    const commands = gateway.mock.calls.map((c) => JSON.parse((c[1] as any).body).command);
    expect(commands).toEqual(expect.arrayContaining(["getparam 1580", "getparam 100"]));
  });

  it("rejects an unknown preset", async () => {
    const { status, body } = await post(`/api/devices/${imei}/config`, { preset: "not_a_preset", value: 1 }, adminToken);
    expect(status).toBe(400);
    expect(body.details.join(" ")).toMatch(/Unknown preset/);
  });

  it("marks a failed gateway delivery as failed", async () => {
    stubGateway(() => fakeResponse(false, 502, "bad gateway"));
    const { status } = await post(
      `/api/devices/${imei}/config`,
      { parameters: [{ param_id: 1581, value: 45 }] },
      adminToken
    );
    expect(status).toBe(201);
    const state = db
      .prepare("SELECT * FROM device_config_state WHERE imei = ? AND param_id = 1581")
      .get(imei) as any;
    expect(state.status).toBe("failed");
    expect(state.response_text).toMatch(/502/);
  });

  it("persists applied state when the tracker ack arrives", async () => {
    stubGateway(() => fakeResponse(true, 202, "{}"));
    const queued = await post(
      `/api/devices/${imei}/config`,
      { parameters: [{ param_id: 1582, value: 7 }] },
      adminToken
    );
    expect(queued.status).toBe(201);

    const ack = await post(
      "/api/telemetry/commands/ack",
      { imei, cmd: "setparam 1582:7", reply: "OK 1582:7" },
      INGEST_TOKEN
    );
    expect(ack.status).toBe(200);
    expect(ack.body.data.status).toBe("applied");

    const state = db
      .prepare("SELECT * FROM device_config_state WHERE imei = ? AND param_id = 1582")
      .get(imei) as any;
    expect(state.status).toBe("applied");
    expect(state.value).toBe("7");
    expect(state.applied_at).toBeTruthy();
  });

  it("persists failed state when the tracker rejects a write", async () => {
    stubGateway(() => fakeResponse(true, 202, "{}"));
    await post(
      `/api/devices/${imei}/config`,
      { parameters: [{ param_id: 2051, value: 500 }] },
      adminToken
    );
    const ack = await post(
      "/api/telemetry/commands/ack",
      { imei, cmd: "setparam 2051:500", reply: "ERROR 2051:500" },
      INGEST_TOKEN
    );
    expect(ack.status).toBe(200);
    expect(ack.body.data.status).toBe("failed");

    const state = db
      .prepare("SELECT * FROM device_config_state WHERE imei = ? AND param_id = 2051")
      .get(imei) as any;
    expect(state.status).toBe("failed");
  });

  it("returns live online status and command history in the config view", async () => {
    const { status, body } = await get(`/api/devices/${imei}/config`, adminToken);
    expect(status).toBe(200);
    expect(body.data.online).toBe(true);
    expect(body.data.device_last_seen_at).toBeTruthy();
    expect(Array.isArray(body.data.command_history)).toBe(true);
    expect(body.data.command_history.length).toBeGreaterThan(0);
    expect(body.data.queued_count).toBeGreaterThanOrEqual(0);
  });

  it("uses the bridge URL contract when MESHSAT_BRIDGE_URL is configured", async () => {
    process.env.MESHSAT_BRIDGE_URL = "https://bridge.test";
    process.env.MESHSAT_BRIDGE_TOKEN = "bridge-secret";
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));

    const { status } = await post(
      `/api/devices/${imei}/config`,
      { parameters: [{ param_id: 1580, value: 81 }] },
      adminToken
    );
    expect(status).toBe(201);
    expect(gateway).toHaveBeenCalledTimes(1);
    const [url, opts] = gateway.mock.calls[0];
    expect(String(url)).toBe(`https://bridge.test/api/devices/${imei}/command`);
    expect((opts as any).headers.Authorization).toBe("Bearer bridge-secret");
    const sent = JSON.parse((opts as any).body);
    expect(sent.imei).toBe(imei);
    expect(sent.command).toBe("setparam 1580:81");
    expect(sent.command_type).toBe("setparam");
    expect(sent.command_id).toBeTruthy();
  });

  it("queues an offline command and flushes it when telemetry checks in", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));
    db.prepare("UPDATE gps_devices SET last_seen_at = datetime('now', '-2 hours') WHERE device_identifier = ?").run(imei);

    const queued = await post(`/api/devices/${imei}/command`, { type: "getinfo" }, adminToken);
    expect(queued.status).toBe(201);
    expect(queued.body.data.status).toBe("queued");
    expect(gateway).not.toHaveBeenCalled();

    const ingest = await post(
      "/api/telemetry/ingest",
      { imei, timestamp: new Date().toISOString(), lat: -9.4438, lon: 147.1803, sats: 6 },
      INGEST_TOKEN
    );
    expect(ingest.status).toBe(201);
    expect(ingest.body.flushed_commands).toBeGreaterThanOrEqual(1);
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(JSON.parse((gateway.mock.calls[0][1] as any).body).command).toBe("getinfo");

    const row = db
      .prepare("SELECT status FROM device_commands WHERE imei = ? AND raw_command = 'getinfo' ORDER BY created_at DESC LIMIT 1")
      .get(imei) as any;
    expect(row.status).toBe("sent");
  });

  it("requires confirmation for setdigout and supports getparam/getinfo commands", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));

    const unconfirmed = await post(`/api/devices/${imei}/command`, { type: "setdigout", dout: 1, reason: "test" }, adminToken);
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toMatch(/confirmation/i);

    const getparam = await post(`/api/devices/${imei}/command`, { type: "getparam", param_id: 100 }, adminToken);
    expect(getparam.status).toBe(201);
    expect(JSON.parse((gateway.mock.calls[0][1] as any).body).command).toBe("getparam 100");

    const getinfo = await post(`/api/devices/${imei}/command`, { type: "getinfo" }, adminToken);
    expect(getinfo.status).toBe(201);
    expect(JSON.parse((gateway.mock.calls[1][1] as any).body).command).toBe("getinfo");

    const cut = await post(
      `/api/devices/${imei}/command`,
      { type: "setdigout", dout: 1, confirm: true, reason: "unit test immobilise" },
      adminToken
    );
    expect(cut.status).toBe(201);
    expect(JSON.parse((gateway.mock.calls[2][1] as any).body).command).toBe("setdigout 1 1");
  });

  it("applies a preset across multiple IMEIs with per-device results", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post(
      "/api/devices/bulk-config",
      { imeis: [imei, imeiB], preset: "reporting_interval", value: 45, reason: "bulk test" },
      adminToken
    );
    expect(status).toBe(200);
    expect(body.data.results).toHaveLength(2);
    expect(body.data.results.every((r: any) => r.ok)).toBe(true);
    expect(gateway).toHaveBeenCalledTimes(2);
    const commands = gateway.mock.calls.map((c) => JSON.parse((c[1] as any).body).command);
    expect(commands).toEqual(expect.arrayContaining(["setparam 100:45", "setparam 100:45"]));
  });

  it("serves the central Teltonika registry with all Configurator sections", async () => {
    const { status, body } = await get("/api/devices/registry", adminToken);
    expect(status).toBe(200);
    expect(body.data.model).toBe("FMB125");
    expect(body.data.sections).toHaveLength(20);
    expect(body.data.sections.map((s: any) => s.key)).toEqual(
      expect.arrayContaining(["status", "security", "system", "gprs", "data-acquisition", "features", "rs232"])
    );
    const features = body.data.sections.find((s: any) => s.key === "features");
    expect(features.features.map((f: any) => f.key)).toEqual(
      expect.arrayContaining(["overspeeding", "immobilizer", "gnss-fuel-counter", "network-jamming", "ibutton-read-notification", "dout-control-via-ignition"])
    );
    const overspeeding = features.features.find((f: any) => f.key === "overspeeding");
    expect(overspeeding.fields.map((f: any) => f.paramId)).toEqual(
      expect.arrayContaining([11100, 11104, 11103, 11101, 11102, 7032, 8032])
    );
  });

  it("lists devices for the IMEI selector", async () => {
    const { status, body } = await get("/api/devices", adminToken);
    expect(status).toBe(200);
    expect(body.data.some((d: any) => d.imei === imei)).toBe(true);
    expect(body.data.find((d: any) => d.imei === imei).online).toBe(true);
  });

  it("queues identity commands and active parameter reads for Load from device", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));
    const { status, body } = await post(
      `/api/devices/${imei}/load`,
      { param_ids: [11100, 11104], reason: "test load" },
      adminToken
    );
    expect(status).toBe(201);
    expect(body.data.param_ids).toEqual([11100, 11104]);
    expect(body.data.commands).toHaveLength(7);
    const sent = gateway.mock.calls.map((c) => JSON.parse((c[1] as any).body).command);
    expect(sent).toEqual(
      expect.arrayContaining(["getinfo", "getver", "getstatus", "getio", "getgps", "getparam 11100", "getparam 11104"])
    );
  });

  it("records identity replies returned directly by the bridge", async () => {
    stubGateway(() =>
      fakeResponse(true, 200, JSON.stringify({ status: "applied", value: "RTC:2026/11/28 00:00:00;Uptime:12345" }))
    );
    const issued = await post(`/api/devices/${imei}/command`, { type: "getinfo" }, adminToken);
    expect(issued.status).toBe(201);

    const { status, body } = await get(`/api/devices/${imei}/config`, adminToken);
    expect(status).toBe(200);
    expect(body.data.device_info.getinfo).toBeTruthy();
    expect(JSON.stringify(body.data.device_info.getinfo)).toContain("Uptime");
  });

  it("requires explicit confirmation before queuing cpureset", async () => {
    const gateway = stubGateway(() => fakeResponse(true, 202, "{}"));
    const rejected = await post(`/api/devices/${imei}/reboot`, { reason: "test" }, adminToken);
    expect(rejected.status).toBe(400);
    expect(gateway).not.toHaveBeenCalled();

    const rebooted = await post(`/api/devices/${imei}/reboot`, { confirm: true, reason: "test reboot" }, adminToken);
    expect(rebooted.status).toBe(201);
    expect(rebooted.body.data.command).toBe("cpureset");
    expect(JSON.parse((gateway.mock.calls[0][1] as any).body).command).toBe("cpureset");
  });

  it("persists firmware from getver acks and exposes it in the config view", async () => {
    stubGateway(() => fakeResponse(true, 202, "{}"));
    const issued = await post(`/api/devices/${imei}/command`, { type: "getver" }, adminToken);
    expect(issued.status).toBe(201);

    const ack = await post(
      "/api/telemetry/commands/ack",
      { imei, cmd: "getver", reply: "FMB125 FW 03.25.15 Rev:32" },
      INGEST_TOKEN
    );
    expect(ack.status).toBe(200);

    const { status, body } = await get(`/api/devices/${imei}/config`, adminToken);
    expect(status).toBe(200);
    expect(body.data.firmware_version).toBe("03.25.15 Rev:32");
    expect(body.data.device_info).toBeTruthy();
    expect(body.data.device_info.last_reply_kind).toBe("getver");
  });
});
