import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { signAccessToken, type AuthUser } from "../middleware/auth";
import camerasRouter from "./cameras";
import { checkCameraFeeds } from "../services/cameras";

let server: Server;
let baseUrl: string;
let adminToken: string;
let vehicleId: string;
let cameraId: string;

const realFetch = globalThis.fetch;

function fakeResponse(ok: boolean, status: number, statusText = "") {
  return {
    ok,
    status,
    statusText,
    body: { cancel: async () => undefined },
  } as unknown as Response;
}

async function post(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function put(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
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
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data: any = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

describe("Camera feed monitoring", () => {
  beforeAll(async () => {
    initSchema();
    const suffix = uuid().substring(0, 8);
    const clientId = uuid();
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientId, `Camera Client ${suffix}`);

    vehicleId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Toyota', 'Hilux', 'Utility', 'Diesel', 'Depot A', ?, 'active')
    `).run(vehicleId, `CAM-V-${suffix}`, `CAM-R-${suffix}`, clientId);

    db.prepare(`
      INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, device_model, client_id, status, last_seen_at)
      VALUES (?, ?, ?, 'teltonika', 'FMB125', ?, 'active', datetime('now'))
    `).run(uuid(), vehicleId, `35401888${suffix}`, clientId);

    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: string } | undefined;
    const adminRoleId = adminRole?.id ?? uuid();
    if (!adminRole) db.prepare("INSERT INTO roles (id, name, description) VALUES (?, 'admin', 'Admin')").run(adminRoleId);
    const adminId = uuid();
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', 'Camera Admin', ?, 'active')")
      .run(adminId, `camera_admin_${suffix}@dspng.tech`, adminRoleId);
    const adminUser: AuthUser = { id: adminId, email: "camera-admin@test", roleName: "admin", airportId: null, clientIds: [] };
    adminToken = signAccessToken(adminUser);

    const app = express();
    app.use(express.json());
    app.use("/api/v1/cameras", camerasRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("requires authentication", async () => {
    const { status } = await get("/api/v1/cameras");
    expect(status).toBe(401);
  });

  it("creates and lists a vehicle camera feed", async () => {
    const created = await post(
      "/api/v1/cameras",
      {
        name: "Cab camera",
        scope: "vehicle",
        vehicleId,
        mode: "snapshot",
        snapshotUrl: "https://camera.test/snapshot.jpg",
        pollIntervalSec: 30,
      },
      adminToken
    );
    expect(created.status).toBe(201);
    cameraId = created.body.data.id;
    expect(created.body.data.vehicle_number).toContain("CAM-V-");

    const list = await get("/api/v1/cameras", adminToken);
    expect(list.status).toBe(200);
    expect(list.body.data.some((feed: any) => feed.id === cameraId)).toBe(true);
  });

  it("returns a failed probe as 200, never a session 401", async () => {
    vi.stubGlobal("fetch", (url: any, opts?: any) => {
      if (String(url).includes("camera.test")) return Promise.resolve(fakeResponse(false, 401, "Unauthorized"));
      return realFetch(url, opts);
    });

    const probe = await post(`/api/v1/cameras/${cameraId}/probe`, undefined, adminToken);
    expect(probe.status).toBe(200);
    expect(probe.body.data.ok).toBe(false);
    expect(probe.body.data.error).toContain("401");
    expect(probe.body.data.feed.last_error).toContain("401");
  });

  it("records a successful probe and marks the feed online", async () => {
    vi.stubGlobal("fetch", (url: any, opts?: any) => {
      if (String(url).includes("camera.test")) return Promise.resolve(fakeResponse(true, 200));
      return realFetch(url, opts);
    });

    const probe = await post(`/api/v1/cameras/${cameraId}/probe`, undefined, adminToken);
    expect(probe.status).toBe(200);
    expect(probe.body.data.ok).toBe(true);
    expect(probe.body.data.feed.status).toBe("online");
    expect(probe.body.data.feed.last_seen_at).toBeTruthy();
  });

  it("raises a deduplicated camera offline alert for a stale feed", async () => {
    db.prepare("UPDATE camera_feeds SET last_seen_at = datetime('now', '-2 hours'), last_checked_at = NULL WHERE id = ?").run(cameraId);
    vi.stubGlobal("fetch", (url: any, opts?: any) => {
      if (String(url).includes("camera.test")) return Promise.reject(new Error("connect ECONNREFUSED"));
      return realFetch(url, opts);
    });

    const created = await checkCameraFeeds(new Date());
    expect(created).toBeGreaterThan(0);
    const alert = db
      .prepare("SELECT alert_type, severity, message FROM fleet_alerts WHERE alert_type = 'camera_offline' ORDER BY created_at DESC LIMIT 1")
      .get() as any;
    expect(alert.alert_type).toBe("camera_offline");
    expect(alert.message).toContain("Cab camera");
  });

  it("updates and removes a feed", async () => {
    const updated = await put(`/api/v1/cameras/${cameraId}`, { name: "Cab camera renamed", isActive: false }, adminToken);
    expect(updated.status).toBe(200);
    expect(updated.body.data.name).toBe("Cab camera renamed");
    expect(updated.body.data.is_active).toBe(false);

    const removed = await fetch(`${baseUrl}/api/v1/cameras/${cameraId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(removed.status).toBe(200);
  });
});
