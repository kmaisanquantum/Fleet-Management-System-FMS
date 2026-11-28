import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import gpsRouter from "./gps";

/**
 * Legacy relay ingest (`POST /api/v1/gps/positions`) must stamp heartbeats and
 * run the same fleet-alert rules as the rich telemetry ingest path. The
 * teltonika-relay and MeshSat fallback still use this endpoint.
 */

const API_KEY = "dev-telemetry-key-12345";

let server: Server;
let baseUrl: string;
let vehicleId: string;
let imei: string;

describe("Legacy GPS ingest", () => {
  beforeAll(async () => {
    initSchema();

    const suffix = uuid().substring(0, 8);
    const clientId = uuid();
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientId, `GPS Client ${suffix}`);

    vehicleId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Toyota', 'Hilux', 'Utility', 'Diesel', 'Ops', ?, 'active')
    `).run(vehicleId, `GPS-V-${suffix}`, `GPS-R-${suffix}`, clientId);

    imei = `35401999${suffix}`;
    db.prepare(`
      INSERT INTO gps_devices (id, vehicle_id, device_identifier, device_type, client_id, status)
      VALUES (?, ?, ?, 'teltonika', ?, 'active')
    `).run(uuid(), vehicleId, imei, clientId);

    const app = express();
    app.use(express.json());
    app.use("/api/v1/gps", gpsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/v1/gps`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("stamps vehicle and device heartbeats", async () => {
    const res = await fetch(`${baseUrl}/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        deviceIdentifier: imei,
        lat: -9.4438,
        lon: 147.1803,
        speed: 20,
        ignition: 1,
        externalVoltage: 12200,
      }),
    });
    expect(res.status).toBe(201);

    const vehicle = db.prepare("SELECT last_seen_at, last_gps_fix_at FROM vehicles WHERE id = ?").get(vehicleId) as {
      last_seen_at: string | null;
      last_gps_fix_at: string | null;
    };
    const device = db.prepare("SELECT last_seen_at FROM gps_devices WHERE device_identifier = ?").get(imei) as {
      last_seen_at: string | null;
    };
    expect(vehicle.last_seen_at).toBeTruthy();
    expect(vehicle.last_gps_fix_at).toBeTruthy();
    expect(device.last_seen_at).toBeTruthy();
  });

  it("raises a fleet alert from legacy ingest", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS count FROM fleet_alerts").get() as { count: number }).count;

    const res = await fetch(`${baseUrl}/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        deviceIdentifier: imei,
        lat: -9.444,
        lon: 147.181,
        speed: 95,
        ignition: 1,
        externalVoltage: 12200,
        io: { "255": 1 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { fleet_alerts?: number };
    expect(body.fleet_alerts).toBeGreaterThan(0);

    const after = (db.prepare("SELECT COUNT(*) AS count FROM fleet_alerts").get() as { count: number }).count;
    expect(after).toBeGreaterThan(before);

    const alert = db
      .prepare("SELECT alert_type, severity, vehicle_id FROM fleet_alerts WHERE vehicle_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(vehicleId) as { alert_type: string; severity: string; vehicle_id: string };
    expect(alert.vehicle_id).toBe(vehicleId);
    expect(alert.alert_type).toBe("overspeed");
    expect(alert.severity).toBe("warning");
  });
});
