import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";
import { signAccessToken, AuthUser } from "../middleware/auth";
import vehiclesRouter from "./vehicles";

let server: Server;
let baseUrl: string;
let token: string;
let suffix: string;

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { status: res.status, body: data };
}

describe("Vehicle GPS tracker settings", () => {
  let vehicleId: string;
  let imei: string;

  beforeAll(async () => {
    initSchema();
    suffix = uuid().substring(0, 8);
    imei = `3540181${suffix}`;

    const roleId = uuid();
    db.prepare("INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, 'admin', ?)").run(roleId, "Admin");
    const role = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: string };

    const userId = uuid();
    db.prepare(
      "INSERT INTO users (id, email, password_hash, full_name, role_id, status) VALUES (?, ?, 'hash', 'GPS Test Admin', ?, 'active')",
    ).run(userId, `gps_admin_${suffix}@dspng.tech`, role.id);

    const user: AuthUser = {
      id: userId,
      email: "gps@test",
      roleName: "admin",
      airportId: null,
      clientIds: [],
    };
    token = signAccessToken(user);

    const app = express();
    app.use(express.json());
    app.use("/api/v1/vehicles", vehiclesRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/v1/vehicles`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("creates a vehicle and binds its GPS tracker", async () => {
    const { status, body } = await request("POST", "", {
      vehicleNumber: `GPS-V-${suffix}`,
      registrationNumber: `GPS-R-${suffix}`,
      make: "Toyota",
      model: "Hilux",
      year: 2024,
      vehicleType: "Utility",
      fuelType: "Diesel",
      gpsImei: imei,
      gpsDeviceType: "teltonika",
      gpsDeviceModel: "FMB125",
      gpsDeviceStatus: "active",
    });

    expect(status).toBe(201);
    expect(body.data.gps_imei).toBe(imei);
    expect(body.data.gps_device_type).toBe("teltonika");
    expect(body.data.gps_device_model).toBe("FMB125");
    expect(body.data.gps_device_status).toBe("active");
    vehicleId = body.data.id;

    const device = db.prepare("SELECT * FROM gps_devices WHERE device_identifier = ?").get(imei) as any;
    expect(device.vehicle_id).toBe(vehicleId);
    expect(device.device_type).toBe("teltonika");
    expect(device.device_model).toBe("FMB125");

    const vehicle = db.prepare("SELECT gps_device_id FROM vehicles WHERE id = ?").get(vehicleId) as any;
    expect(vehicle.gps_device_id).toBe(device.id);
  });

  it("returns tracker details in vehicle reads", async () => {
    const detail = await request("GET", `/${vehicleId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.gps_imei).toBe(imei);

    const list = await request("GET", "");
    expect(list.status).toBe(200);
    const row = list.body.data.find((v: any) => v.id === vehicleId);
    expect(row?.gps_imei).toBe(imei);
    expect(row?.gps_device_model).toBe("FMB125");
  });

  it("updates tracker details and unbinds when the IMEI is cleared", async () => {
    const update = await request("PUT", `/${vehicleId}`, {
      gpsImei: imei,
      gpsDeviceType: "meshsat",
      gpsDeviceModel: "FMC130",
      gpsDeviceStatus: "maintenance",
    });
    expect(update.status).toBe(200);
    expect(update.body.data.gps_device_type).toBe("meshsat");
    expect(update.body.data.gps_device_model).toBe("FMC130");
    expect(update.body.data.gps_device_status).toBe("maintenance");

    const device = db.prepare("SELECT * FROM gps_devices WHERE device_identifier = ?").get(imei) as any;
    expect(device.device_model).toBe("FMC130");
    expect(device.status).toBe("maintenance");

    const clear = await request("PUT", `/${vehicleId}`, { gpsImei: "" });
    expect(clear.status).toBe(200);
    expect(clear.body.data.gps_imei).toBeNull();

    const released = db.prepare("SELECT * FROM gps_devices WHERE device_identifier = ?").get(imei) as any;
    expect(released.vehicle_id).toBeNull();
    const vehicle = db.prepare("SELECT gps_device_id FROM vehicles WHERE id = ?").get(vehicleId) as any;
    expect(vehicle.gps_device_id).toBeNull();
  });

  it("moves a tracker between vehicles and releases it on delete", async () => {
    const bind = await request("PUT", `/${vehicleId}`, {
      gpsImei: imei,
      gpsDeviceType: "teltonika",
      gpsDeviceModel: "FMB125",
      gpsDeviceStatus: "active",
    });
    expect(bind.status).toBe(200);

    const second = await request("POST", "", {
      vehicleNumber: `GPS-V2-${suffix}`,
      registrationNumber: `GPS-R2-${suffix}`,
      make: "Ford",
      model: "Ranger",
      vehicleType: "Utility",
      fuelType: "Diesel",
    });
    expect(second.status).toBe(201);
    const secondId = second.body.data.id;

    const move = await request("PUT", `/${secondId}`, {
      gpsImei: imei,
      gpsDeviceType: "teltonika",
      gpsDeviceModel: "FMB125",
      gpsDeviceStatus: "active",
    });
    expect(move.status).toBe(200);
    expect(move.body.data.gps_imei).toBe(imei);

    const first = db.prepare("SELECT gps_device_id FROM vehicles WHERE id = ?").get(vehicleId) as any;
    expect(first.gps_device_id).toBeNull();
    const device = db.prepare("SELECT vehicle_id FROM gps_devices WHERE device_identifier = ?").get(imei) as any;
    expect(device.vehicle_id).toBe(secondId);

    const del = await request("DELETE", `/${secondId}`);
    expect(del.status).toBe(204);
    const released = db.prepare("SELECT vehicle_id FROM gps_devices WHERE device_identifier = ?").get(imei) as any;
    expect(released.vehicle_id).toBeNull();
  });

  it("deletes a vehicle with a bound tracker and releases the device", async () => {
    const bind = await request("PUT", `/${vehicleId}`, { gpsImei: imei });
    expect(bind.status).toBe(200);

    const del = await request("DELETE", `/${vehicleId}`);
    expect(del.status).toBe(204);

    const device = db.prepare("SELECT vehicle_id FROM gps_devices WHERE device_identifier = ?").get(imei) as any;
    expect(device.vehicle_id).toBeNull();
  });
});
