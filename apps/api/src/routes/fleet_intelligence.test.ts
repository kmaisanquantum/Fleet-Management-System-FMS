import { describe, it, expect, beforeAll } from "vitest";
import { db, initSchema } from "../db";
import { v4 as uuid } from "uuid";
import { reconcileTransaction, calculateHaversineDistanceKm, createFleetExceptionsForTransaction } from "../services/reconciliation";

describe("Fleet Intelligence & Reconciliation Rules Engine Tests", () => {
  let vehicleId: string;
  let otherVehicleId: string;
  let driverId: string;
  let otherDriverId: string;
  let cardId: string;
  let otherCardId: string;
  let stationId: string;
  let deviceIdentifier: string;

  beforeAll(() => {
    initSchema();
    const s = uuid().substring(0, 6);

    vehicleId = uuid();
    otherVehicleId = uuid();
    cardId = uuid();
    otherCardId = uuid();
    driverId = uuid();
    otherDriverId = uuid();
    stationId = uuid();
    deviceIdentifier = `MESHSAT-NODE-${s}`;

    // Create test vehicle (80L capacity, 8.0 km/L)
    db.prepare(`
      INSERT INTO vehicles (
        id, vehicle_number, registration_number, make, model, year, vehicle_type,
        fuel_type, department, status, tank_capacity_litres, expected_km_per_l
      ) VALUES (?, ?, ?, 'Toyota', 'Hilux', 2022, 'Utility', 'Diesel', 'Ops', 'active', 80.0, 8.0)
    `).run(vehicleId, `TEST-V1-${s}`, `REG-V1-${s}`);

    db.prepare(`
      INSERT INTO vehicles (
        id, vehicle_number, registration_number, make, model, year, vehicle_type,
        fuel_type, department, status, tank_capacity_litres, expected_km_per_l
      ) VALUES (?, ?, ?, 'Ford', 'Ranger', 2023, 'Utility', 'Diesel', 'Ops', 'active', 80.0, 8.0)
    `).run(otherVehicleId, `TEST-V2-${s}`, `REG-V2-${s}`);

    // Register GPS device
    db.prepare(`
      INSERT INTO gps_devices (id, vehicle_id, device_identifier, status)
      VALUES (?, ?, ?, 'active')
    `).run(uuid(), vehicleId, deviceIdentifier);

    // Create test drivers
    db.prepare(`
      INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_expiry)
      VALUES (?, ?, 'Test Driver 1', 'Ops', ?, '2028-01-01')
    `).run(driverId, `EMP-T1-${s}`, `DL-T1-${s}`);

    db.prepare(`
      INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_expiry)
      VALUES (?, ?, 'Test Driver 2', 'Ops', ?, '2028-01-01')
    `).run(otherDriverId, `EMP-T2-${s}`, `DL-T2-${s}`);

    // Create matching fuel card
    db.prepare(`
      INSERT INTO fuel_cards (id, card_number, vehicle_id, authorised_driver_id, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(cardId, `CARD-MATCH-${s}`, vehicleId, driverId);

    // Create mismatched card assigned to otherVehicleId
    db.prepare(`
      INSERT INTO fuel_cards (id, card_number, vehicle_id, authorised_driver_id, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(otherCardId, `CARD-OTHER-${s}`, otherVehicleId, otherDriverId);

    // Create station in Port Moresby (-9.4438, 147.1803)
    db.prepare(`
      INSERT INTO fuel_stations (id, name, code, station_type, lat, lon, address)
      VALUES (?, 'POM Test Station', ?, 'station', -9.4438, 147.1803, 'Port Moresby')
    `).run(stationId, `STN-T1-${s}`);

    // Add GPS position matching station coordinates
    db.prepare(`
      INSERT INTO gps_positions (id, vehicle_id, lat, lon, speed, recorded_at)
      VALUES (?, ?, -9.4438, 147.1803, 0, '2026-03-28 10:00:00')
    `).run(uuid(), vehicleId);
  });

  it("calculates Haversine distance correctly", () => {
    // Distance from Port Moresby (-9.4438, 147.1803) to Lae (-6.7265, 146.9944) ~300km
    const dist = calculateHaversineDistanceKm(-9.4438, 147.1803, -6.7265, 146.9944);
    expect(dist).toBeGreaterThan(250);
    expect(dist).toBeLessThan(350);

    // Distance to same point is 0
    const zeroDist = calculateHaversineDistanceKm(-9.4438, 147.1803, -9.4438, 147.1803);
    expect(zeroDist).toBeCloseTo(0, 5);
  });

  it("verifies clean transaction when all conditions match", () => {
    const result = reconcileTransaction({
      vehicle_id: vehicleId,
      driver_id: driverId,
      fuel_card_id: cardId,
      station_id: stationId,
      date: "2026-03-28",
      time: "10:00:00",
      fuel_type: "Diesel",
      litres: 50.0,
      cost_per_litre: 3.80,
      total_cost: 190.0,
      odometer_reading: 50000,
    });

    expect(result.status).toBe("verified");
    expect(result.violations.length).toBe(0);
    expect(result.gps_verified).toBe(true);
  });

  it("triggers RULE_CAPACITY_EXCEEDED when refuel litres exceeds tank capacity", () => {
    const result = reconcileTransaction({
      vehicle_id: vehicleId,
      driver_id: driverId,
      fuel_card_id: cardId,
      station_id: stationId,
      date: "2026-03-28",
      time: "10:00:00",
      fuel_type: "Diesel",
      litres: 120.0, // Tank is 80L
      cost_per_litre: 3.80,
      total_cost: 456.0,
      odometer_reading: 50100,
    });

    expect(result.status).toBe("exception");
    const violation = result.violations.find((v) => v.rule_code === "RULE_CAPACITY_EXCEEDED");
    expect(violation).toBeDefined();
    expect(violation?.severity).toBe("critical");
  });

  it("triggers RULE_CARD_MISMATCH when fuel card assigned to another vehicle is presented", () => {
    const result = reconcileTransaction({
      vehicle_id: vehicleId,
      driver_id: driverId,
      fuel_card_id: otherCardId,
      station_id: stationId,
      date: "2026-03-28",
      time: "10:00:00",
      fuel_type: "Diesel",
      litres: 40.0,
      cost_per_litre: 3.80,
      total_cost: 152.0,
      odometer_reading: 50200,
    });

    expect(result.status).toBe("exception");
    const violation = result.violations.find((v) => v.rule_code === "RULE_CARD_MISMATCH");
    expect(violation).toBeDefined();
    expect(violation?.severity).toBe("critical");
  });

  it("resolves deviceIdentifier to vehicle_id and inserts altitude_m, battery_pct, and source", () => {
    const devRow = db.prepare("SELECT vehicle_id FROM gps_devices WHERE device_identifier = ?").get(deviceIdentifier) as any;
    expect(devRow).toBeDefined();
    expect(devRow.vehicle_id).toBe(vehicleId);

    const posId = uuid();
    db.prepare(`
      INSERT INTO gps_positions (id, vehicle_id, lat, lon, speed, heading, ignition, odometer, altitude_m, battery_pct, source, recorded_at)
      VALUES (?, ?, -9.4438, 147.1803, 15, 90, 1, 50400, 45.5, 88.0, 'meshsat', datetime('now'))
    `).run(posId, devRow.vehicle_id);

    const inserted = db.prepare("SELECT * FROM gps_positions WHERE id = ?").get(posId) as any;
    expect(inserted).toBeDefined();
    expect(inserted.vehicle_id).toBe(vehicleId);
    expect(inserted.altitude_m).toBe(45.5);
    expect(inserted.battery_pct).toBe(88.0);
    expect(inserted.source).toBe("meshsat");
  });

  it("generates fleet_exception rows in DB upon rule violations", () => {
    const txnId = uuid();
    db.prepare(`
      INSERT INTO vehicle_fuel_logs (id, vehicle_id, driver_id, date, fuel_type, litres, cost_per_litre, total_cost, odometer_reading)
      VALUES (?, ?, ?, '2026-03-28', 'Diesel', 120.0, 3.80, 456.0, 50300)
    `).run(txnId, vehicleId, driverId);

    const violations = [
      {
        rule_code: "RULE_CAPACITY_EXCEEDED",
        severity: "critical" as const,
        category: "fuel" as const,
        description: "Refuel litres 120L exceeds 80L capacity",
      },
    ];

    createFleetExceptionsForTransaction(txnId, {
      vehicle_id: vehicleId,
      driver_id: driverId,
      date: "2026-03-28",
      fuel_type: "Diesel",
      litres: 120.0,
      cost_per_litre: 3.80,
      total_cost: 456.0,
      odometer_reading: 50300,
    }, violations);

    const exc = db.prepare("SELECT * FROM fleet_exceptions WHERE transaction_id = ?").get(txnId) as any;
    expect(exc).toBeDefined();
    expect(exc.rule_code).toBe("RULE_CAPACITY_EXCEEDED");
    expect(exc.status).toBe("open");
  });
});
