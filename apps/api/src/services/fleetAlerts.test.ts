import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { nowSql } from "../utils/deviceStatus";
import { evaluateTelemetryAlerts, persistFleetAlerts, type TelemetryAlertContext } from "./fleetAlerts";

describe("fleet alert engine", () => {
  let vehicleId: string;
  let imei: string;
  let clientId: string;

  beforeAll(() => {
    delete process.env.SMTP_HOST;
    initSchema();
    const suffix = uuid().substring(0, 8);
    clientId = uuid();
    db.prepare("INSERT INTO clients (id, name) VALUES (?, ?)").run(clientId, `Alert Client ${suffix}`);
    vehicleId = uuid();
    db.prepare(`
      INSERT INTO vehicles (id, vehicle_number, registration_number, make, model, vehicle_type, fuel_type, department, client_id, status)
      VALUES (?, ?, ?, 'Toyota', 'Hilux', 'Utility', 'Diesel', 'Operations', ?, 'active')
    `).run(vehicleId, `ALT-V-${suffix}`, `ALT-R-${suffix}`, clientId);
    imei = `35401777${suffix}`;
  });

  afterAll(() => {
    db.prepare("DELETE FROM email_deliveries WHERE related_alert_id IN (SELECT id FROM fleet_alerts WHERE vehicle_id = ?) OR subject LIKE ?")
      .run(vehicleId, "%ALT-V-%");
    db.prepare("DELETE FROM fleet_alerts WHERE vehicle_id = ?").run(vehicleId);
    db.prepare("DELETE FROM vehicles WHERE id = ?").run(vehicleId);
    db.prepare("DELETE FROM clients WHERE id = ?").run(clientId);
  });

  function context(overrides: Partial<TelemetryAlertContext> = {}): TelemetryAlertContext {
    return {
      imei,
      vehicleId,
      vehicleNumber: "ALT-V",
      registrationNumber: "ALT-R",
      clientId,
      lat: -9.4438,
      lon: 147.1803,
      speed: 96,
      ignition: 1,
      voltage: 10.4,
      recordedAt: nowSql(),
      io: { "239": 1, "66": 10400, "249": 1, "300": 1, "1": 1 },
      previous: { ignition: 0, extVoltageV: 12.5, lat: -9.4438, lon: 147.1803, io: { "1": 0 } },
      ...overrides,
    };
  }

  it("raises overspeed, ignition, voltage and security candidates", () => {
    const candidates = evaluateTelemetryAlerts(context());
    const types = candidates.map((candidate) => candidate.alertType);
    expect(types).toContain("overspeed");
    expect(types).toContain("ignition_on");
    expect(types).toContain("low_voltage");
    expect(types).toContain("jamming");
    expect(types).toContain("sos");
    expect(types).toContain("din_trigger");
  });

  it("persists alerts once and suppresses duplicates inside the cooldown", () => {
    const candidates = evaluateTelemetryAlerts(context({ speed: 120 }));
    const createdAt = nowSql();
    const first = persistFleetAlerts(candidates, {
      imei,
      vehicleId,
      lat: -9.4438,
      lon: 147.1803,
      speed: 120,
      voltage: 10.4,
      createdAt,
    });
    expect(first.length).toBeGreaterThan(0);

    const stored = db.prepare("SELECT alert_type, severity, email_sent FROM fleet_alerts WHERE vehicle_id = ?").all(vehicleId) as any[];
    expect(stored.some((row) => row.alert_type === "overspeed")).toBe(true);
    expect(stored.some((row) => row.severity === "critical")).toBe(true);

    const second = persistFleetAlerts(candidates, {
      imei,
      vehicleId,
      lat: -9.4438,
      lon: 147.1803,
      speed: 120,
      voltage: 10.4,
      createdAt,
    });
    expect(second.length).toBe(0);
  });
});
