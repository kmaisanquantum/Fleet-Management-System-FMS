import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { signAccessToken, type AuthUser } from "../middleware/auth";
import reportsRouter from "./reports";
import alertSettingsRouter from "./alertSettings";

/**
 * Fleet reporting + alert settings tests. These exercise the real Express
 * router, tenant scope, report builders, CSV serialisation and SMTP
 * "not configured" fallback (no network is attempted).
 */

let server: Server;
let baseUrl: string;
let adminToken: string;
let clientToken: string;
let vehicleId: string;
let imei: string;
let clientId: string;
let alertId: string;
let adminId: string;
let clientUserId: string;

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const raw = await res.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  return { status: res.status, body, text: raw, contentType: res.headers.get("content-type") };
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

describe("Fleet reporting and alert settings", () => {
  beforeAll(async () => {
    delete process.env.SMTP_HOST;
    initSchema();
    const s = uuid().substring(0, 8);
    clientId = uuid();
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientId, `Report Client ${s}`);

    vehicleId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status, tank_capacity_litres, expected_km_per_l)
      VALUES (?, ?, ?, 'Toyota', 'Hilux', 'Utility', 'Diesel', 'Operations', ?, 'active', 80, 8.5)
    `).run(vehicleId, `RPT-V-${s}`, `RPT-R-${s}`, clientId);

    imei = `35401999${s}`;
    db.prepare(`
      INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, device_model, client_id, status, last_seen_at)
      VALUES (?, ?, ?, 'teltonika', 'FMB125', ?, 'active', datetime('now'))
    `).run(uuid(), vehicleId, imei, clientId);

    db.prepare(`
      INSERT INTO geofences (id, name, client_id, lat, lon, radius_meters, status)
      VALUES (?, ?, ?, -9.4438, 147.1803, 500, 'active')
    `).run(uuid(), `Depot ${s}`, clientId);

    const insertPosition = db.prepare(`
      INSERT INTO telemetry_records (id, vehicle_id, imei, lat, lon, speed_kmh, ignition, odometer_km, fuel_liters, ext_voltage_v, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertPosition.run(uuid(), vehicleId, imei, -9.4438, 147.1803, 0, 1, 1000, 50, 12.4, "2026-03-01 01:00:00");
    insertPosition.run(uuid(), vehicleId, imei, -9.4538, 147.1903, 45, 1, 1005, 49, 12.3, "2026-03-01 01:10:00");
    insertPosition.run(uuid(), vehicleId, imei, -9.4638, 147.2003, 0, 0, 1010, 48, 12.2, "2026-03-01 01:20:00");

    alertId = uuid();
    db.prepare(`
      INSERT INTO fleet_alerts (id, imei, vehicle_id, alert_type, severity, message, lat, lon, speed, voltage, created_at, rule_code, dedupe_key)
      VALUES (?, ?, ?, 'overspeed', 'warning', 'Test overspeed alert', -9.45, 147.19, 95, 12.3, datetime('now'), 'RULE_OVERSPEED', ?)
    `).run(alertId, imei, vehicleId, `${imei}:overspeed:test`);

    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: string } | undefined;
    const clientRole = db.prepare("SELECT id FROM roles WHERE name = 'client_user'").get() as { id: string } | undefined;
    const adminRoleId = adminRole?.id ?? uuid();
    const clientRoleId = clientRole?.id ?? uuid();
    if (!adminRole) db.prepare("INSERT INTO roles (id, name, description) VALUES (?, 'admin', 'Admin')").run(adminRoleId);
    if (!clientRole) db.prepare("INSERT INTO roles (id, name, description) VALUES (?, 'client_user', 'Client User')").run(clientRoleId);
    adminId = uuid();
    clientUserId = uuid();
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', 'Report Admin', ?, 'active')")
      .run(adminId, `report_admin_${s}@dspng.tech`, adminRoleId);
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', 'Report Client', ?, 'active')")
      .run(clientUserId, `report_client_${s}@dspng.tech`, clientRoleId);
    db.prepare("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)").run(clientUserId, clientId);

    const adminUser: AuthUser = { id: adminId, email: "report_admin@test", roleName: "admin", airportId: null, clientIds: [] };
    const clientUser: AuthUser = { id: clientUserId, email: "report_client@test", roleName: "client_user", airportId: null, clientIds: [clientId] };
    adminToken = signAccessToken(adminUser);
    clientToken = signAccessToken(clientUser);

    const app = express();
    app.use(express.json());
    app.use("/api/v1/reports", reportsRouter);
    app.use("/api/v1/alert-settings", alertSettingsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!vehicleId) return;
    db.prepare("DELETE FROM email_deliveries WHERE subject LIKE ? OR subject LIKE ? OR related_alert_id IN (SELECT id FROM fleet_alerts WHERE vehicle_id = ?)")
      .run("%2026-03-01%", "FMS SMTP test%", vehicleId);
    db.prepare("DELETE FROM fleet_alerts WHERE vehicle_id = ?").run(vehicleId);
    db.prepare("DELETE FROM telemetry_records WHERE vehicle_id = ?").run(vehicleId);
    db.prepare("DELETE FROM gps_devices WHERE vehicle_id = ?").run(vehicleId);
    db.prepare("DELETE FROM geofences WHERE client_id = ?").run(clientId);
    db.prepare("DELETE FROM user_clients WHERE user_id IN (?, ?)").run(adminId, clientUserId);
    db.prepare("DELETE FROM audit_logs WHERE user_id IN (?, ?)").run(adminId, clientUserId);
    db.prepare("DELETE FROM users WHERE id IN (?, ?)").run(adminId, clientUserId);
    db.prepare("DELETE FROM vehicles WHERE id = ?").run(vehicleId);
    db.prepare("DELETE FROM clients WHERE id = ?").run(clientId);
  });

  it("returns report options scoped to the caller", async () => {
    const admin = await get("/api/v1/reports/options", adminToken);
    expect(admin.status).toBe(200);
    expect(admin.body.data.vehicles.some((vehicle: any) => vehicle.id === vehicleId)).toBe(true);
    expect(admin.body.data.recipient).toBe("fleet@dspng.tech");

    const client = await get("/api/v1/reports/options", clientToken);
    expect(client.status).toBe(200);
    expect(client.body.data.vehicles.every((vehicle: any) => vehicle.client_id === clientId)).toBe(true);
  });

  it("builds a trip and mileage report from telemetry", async () => {
    const res = await get(
      `/api/v1/reports/trip-mileage?from=2026-03-01T00:00&to=2026-03-01T23:59&vehicleId=${vehicleId}`,
      adminToken
    );
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("Trip & Mileage Summary");
    expect(res.body.data.kpis.length).toBeGreaterThan(0);
    const summary = res.body.data.sections.find((section: any) => section.key === "summary");
    expect(summary.rows[0].vehicle).toContain("RPT-V-");
    expect(summary.rows[0].distance_km).toBeGreaterThan(0);
  });

  it("builds every report type without SQL or shape errors", async () => {
    const types = ["trip-mileage", "driver-behaviour", "geofence-idle", "fuel-utilization", "device-health"];
    for (const type of types) {
      const res = await get(
        `/api/v1/reports/${type}?from=2026-03-01T00:00&to=2026-03-01T23:59&vehicleId=${vehicleId}`,
        adminToken
      );
      expect(res.status, `${type}: ${res.text.slice(0, 200)}`).toBe(200);
      expect(res.body.data.sections.length, type).toBeGreaterThan(0);
      expect(res.body.data.kpis.length, type).toBeGreaterThan(0);
    }
  });

  it("returns CSV with the report title and rows", async () => {
    const res = await get(
      `/api/v1/reports/fuel-utilization?from=2026-03-01T00:00&to=2026-03-01T23:59&vehicleId=${vehicleId}&format=csv`,
      adminToken
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/csv");
    expect(res.text).toContain("Fuel & Utilization");
    expect(res.text).toContain("RPT-V-");
  });

  it("falls back cleanly when SMTP is not configured", async () => {
    const res = await post(
      `/api/v1/reports/trip-mileage/email?from=2026-03-01T00:00&to=2026-03-01T23:59&vehicleId=${vehicleId}`,
      {},
      adminToken
    );
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("skipped");
    expect(res.body.data.error).toContain("SMTP");
  });

  it("loads and updates alert/email settings", async () => {
    const before = await get("/api/v1/alert-settings", adminToken);
    expect(before.status).toBe(200);
    expect(before.body.data.recipients.alert).toBe("fleet@dspng.tech");
    expect(before.body.data.smtp.configured).toBe(false);

    const update = await put(
      "/api/v1/alert-settings",
      { thresholds: { overspeedKmh: 95, lowVoltageV: 11.2 }, recipients: { alertCc: "ops@dspng.tech" } },
      adminToken
    );
    expect(update.status).toBe(200);
    expect(update.body.data.thresholds.overspeedKmh).toBe(95);
    expect(update.body.data.recipients.alertCc).toBe("ops@dspng.tech");

    const client = await get("/api/v1/alert-settings", clientToken);
    expect(client.status).toBe(403);
  });

  it("sends a test email through the configured fallback path and logs it", async () => {
    const res = await post("/api/v1/alert-settings/test-email", {}, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("skipped");
    expect(res.body.message).toContain("SMTP");

    const deliveries = await get("/api/v1/alert-settings/deliveries?limit=20", adminToken);
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.data.some((delivery: any) => delivery.kind === "test")).toBe(true);

    const alerts = await get("/api/v1/alert-settings/alerts?limit=500", adminToken);
    expect(alerts.status).toBe(200);
    expect(alerts.body.data.some((alert: any) => alert.id === alertId)).toBe(true);
  });
});
