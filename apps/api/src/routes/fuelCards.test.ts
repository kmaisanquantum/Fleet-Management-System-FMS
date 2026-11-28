import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { signAccessToken, type AuthUser } from "../middleware/auth";
import fuelCardsRouter from "./fuelCards";
import { normalizeTransactionTimestamp } from "../services/fuelCards";

let server: Server;
let baseUrl: string;
let adminToken: string;
let clientToken: string;
let vehicleId: string;
let imei: string;
let clientId: string;

const TXN_TIME = "2026-04-01T01:00:00Z";

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

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data: any = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

describe("Fuel cards and reconciliation", () => {
  beforeAll(async () => {
    initSchema();
    const suffix = uuid().substring(0, 8);
    clientId = uuid();
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientId, `Fuel Card Client ${suffix}`);

    vehicleId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status, tank_capacity_litres)
      VALUES (?, ?, ?, 'Toyota', 'Hilux', 'Utility', 'Diesel', 'Operations', ?, 'active', 80)
    `).run(vehicleId, `FC-V-${suffix}`, `FC-R-${suffix}`, clientId);

    imei = `35401777${suffix}`;
    db.prepare(`
      INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, device_model, client_id, status, last_seen_at)
      VALUES (?, ?, ?, 'teltonika', 'FMB125', ?, 'active', datetime('now'))
    `).run(uuid(), vehicleId, imei, clientId);

    db.prepare(`
      INSERT INTO telemetry_records (id, vehicle_id, imei, lat, lon, speed_kmh, ignition, odometer_km, fuel_liters, recorded_at)
      VALUES (?, ?, ?, -9.4438, 147.1803, 0, 1, 1200, 45, '2026-04-01 01:00:00')
    `).run(uuid(), vehicleId, imei);

    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: string } | undefined;
    const clientRole = db.prepare("SELECT id FROM roles WHERE name = 'client_user'").get() as { id: string } | undefined;
    const adminRoleId = adminRole?.id ?? uuid();
    const clientRoleId = clientRole?.id ?? uuid();
    if (!adminRole) db.prepare("INSERT INTO roles (id, name, description) VALUES (?, 'admin', 'Admin')").run(adminRoleId);
    if (!clientRole) db.prepare("INSERT INTO roles (id, name, description) VALUES (?, 'client_user', 'Client')").run(clientRoleId);
    const adminId = uuid();
    const clientUserId = uuid();
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', 'Fuel Card Admin', ?, 'active')")
      .run(adminId, `fuel_card_admin_${suffix}@dspng.tech`, adminRoleId);
    db.prepare("INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', 'Fuel Card Client', ?, 'active')")
      .run(clientUserId, `fuel_card_client_${suffix}@dspng.tech`, clientRoleId);
    db.prepare("INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)").run(clientUserId, clientId);

    const adminUser: AuthUser = { id: adminId, email: "fuel-card-admin@test", roleName: "admin", airportId: null, clientIds: [] };
    const clientUser: AuthUser = { id: clientUserId, email: "fuel-card-client@test", roleName: "client_user", airportId: null, clientIds: [clientId] };
    adminToken = signAccessToken(adminUser);
    clientToken = signAccessToken(clientUser);

    const app = express();
    app.use(express.json());
    app.use("/api/v1/fuel-cards", fuelCardsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("requires authentication", async () => {
    const { status } = await get("/api/v1/fuel-cards");
    expect(status).toBe(401);
  });

  it("registers a card and logs a GPS-matched swipe", async () => {
    const created = await post(
      "/api/v1/fuel-cards",
      {
        cardNumber: `FC-CARD-${uuid().substring(0, 6)}`,
        provider: "Puma",
        vehicleId,
        status: "active",
        dailyLimitLiters: 100,
        monthlyLimitAmount: 1000,
      },
      adminToken
    );
    expect(created.status).toBe(201);
    expect(created.body.data.vehicle_number).toContain("FC-V-");

    const swipe = await post(
      `/api/v1/fuel-cards/${created.body.data.id}/swipe`,
      {
        transactionAt: TXN_TIME,
        stationName: "Puma Port Moresby",
        stationLat: -9.4438,
        stationLon: 147.1803,
        liters: 40,
        amount: 150,
        currency: "PGK",
      },
      adminToken
    );
    expect(swipe.status).toBe(201);
    expect(swipe.body.data.status).toBe("matched");
    expect(swipe.body.data.distance_km).toBeLessThan(1);
  });

  it("flags a swipe far from the vehicle GPS and creates an alert", async () => {
    const card = await post(
      "/api/v1/fuel-cards",
      { cardNumber: `FC-FLAG-${uuid().substring(0, 6)}`, vehicleId, dailyLimitLiters: 100 },
      adminToken
    );
    const swipe = await post(
      `/api/v1/fuel-cards/${card.body.data.id}/swipe`,
      {
        transactionAt: TXN_TIME,
        stationName: "Far Station",
        stationLat: -9.6000,
        stationLon: 147.4000,
        liters: 30,
        amount: 120,
      },
      adminToken
    );
    expect(swipe.status).toBe(201);
    expect(swipe.body.data.status).toBe("flagged");
    expect(swipe.body.data.flag_reason).toContain("km from the station");
    expect(swipe.body.reconciliation.alertsCreated).toBeGreaterThan(0);

    const alert = db
      .prepare("SELECT alert_type, severity, message FROM fleet_alerts WHERE vehicle_id = ? AND alert_type = 'fuel_card_anomaly' ORDER BY created_at DESC LIMIT 1")
      .get(vehicleId) as any;
    expect(alert.alert_type).toBe("fuel_card_anomaly");
    expect(alert.message).toContain("Fuel card");
  });

  it("flags a lost card even when the GPS matches", async () => {
    const card = await post(
      "/api/v1/fuel-cards",
      { cardNumber: `FC-LOST-${uuid().substring(0, 6)}`, vehicleId, status: "lost" },
      adminToken
    );
    const swipe = await post(
      `/api/v1/fuel-cards/${card.body.data.id}/swipe`,
      { transactionAt: TXN_TIME, stationLat: -9.4438, stationLon: 147.1803, liters: 20, amount: 80 },
      adminToken
    );
    expect(swipe.status).toBe(201);
    expect(swipe.body.data.status).toBe("flagged");
    expect(swipe.body.data.flag_reason).toContain("lost");
  });

  it("imports CSV rows and skips duplicates", async () => {
    const cardNumber = `FC-CSV-${uuid().substring(0, 6)}`;
    await post("/api/v1/fuel-cards", { cardNumber, vehicleId }, adminToken);
    const csv = [
      "card_number,transaction_at,station_name,station_lat,station_lon,liters,amount,currency",
      `${cardNumber},2026-04-02T02:00:00Z,CSV Station,-9.4438,147.1803,25,100,PGK`,
      `${cardNumber},2026-04-02T02:00:00Z,CSV Station,-9.4438,147.1803,25,100,PGK`,
    ].join("\n");
    const result = await post("/api/v1/fuel-cards/import", { csv }, adminToken);
    expect(result.status).toBe(201);
    expect(result.body.data.imported).toBe(1);
    expect(result.body.data.duplicates).toBe(1);
  });

  it("returns summary and scoped transaction data", async () => {
    const summary = await get("/api/v1/fuel-cards/summary", adminToken);
    expect(summary.status).toBe(200);
    expect(summary.body.data.transactions.total).toBeGreaterThan(0);

    const clientCards = await get("/api/v1/fuel-cards", clientToken);
    expect(clientCards.status).toBe(200);
    expect(Array.isArray(clientCards.body.data)).toBe(true);
  });

  it("blocks a card through the update endpoint", async () => {
    const card = await post("/api/v1/fuel-cards", { cardNumber: `FC-BLOCK-${uuid().substring(0, 6)}` }, adminToken);
    const updated = await put(`/api/v1/fuel-cards/${card.body.data.id}`, { status: "suspended" }, adminToken);
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe("suspended");
  });

  it("treats timezone-less swipe times as Port Moresby time", () => {
    expect(normalizeTransactionTimestamp("2026-04-01T01:00")).toBe("2026-03-31 15:00:00");
    expect(normalizeTransactionTimestamp("2026-04-01 01:00:00")).toBe("2026-03-31 15:00:00");
    expect(normalizeTransactionTimestamp("2026-04-01T01:00:00Z")).toBe("2026-04-01 01:00:00");
  });
});
