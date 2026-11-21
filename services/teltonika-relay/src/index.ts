import net from "net";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { AvlRecord, parseAvlPacket } from "./codec";

dotenv.config();

/**
 * Teltonika AVL IO element ids mapped to FMS telemetry fields.
 * See TELTONIKA_INTEGRATION.md for the full mapping table.
 */
export const IO = {
  ODOMETER: 16,
  GSM_SIGNAL: 21,
  FUEL_LEVEL: 30,
  ENGINE_RPM: 36,
  EXTERNAL_VOLTAGE: 66,
  BATTERY_VOLTAGE: 67,
  BATTERY_LEVEL: 113,
  IGNITION: 239,
  MOVEMENT: 240,
  CRASH: 247,
  HARSH_ACCEL: 248,
  HARSH_BRAKING: 249,
  HARSH_CORNERING: 250,
  TRIP_ODOMETER: 389,
  FUEL_LEVEL_CAN: 81,
  IBUTTON_ID: 78,
  BLE_DRIVER_ID: 385,
  GEOFENCE_ZONE_1: 155,
  GEOFENCE_ZONE_2: 156,
  ENGINE_HOURS: 1023,
} as const;

export interface TeltonikaRelayConfig {
  port: number;
  healthPort: number;
  fmsUrl: string;
  fmsApiKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TeltonikaRelayConfig {
  return {
    port: Number(env.PORT) || 6056,
    healthPort: Number(env.HEALTH_PORT) || 6057,
    fmsUrl: (env.FMS_URL || "https://fleet.dspng.tech").replace(/\/$/, ""),
    fmsApiKey: env.FMS_API_KEY || "dev-telemetry-key-12345",
  };
}

export interface FmsTelemetryPayload {
  deviceIdentifier: string;
  lat: number;
  lon: number;
  speed: number;
  heading: number;
  ignition: number;
  odometer: number;
  altitude: number;
  battery?: number;
  source: "teltonika";
  recordedAt: string;
  geofenceStatus?: string;
  ignitionSource?: string;
  movementSource?: string;
  gsmSignal?: number;
  externalVoltage?: number;
  geofenceZoneId?: string;
  tripOdometer?: number;
  fuelLevelPct?: number;
  engineRpm?: number;
  engineHours?: number;
  harshEvent?: "harsh_acceleration" | "harsh_braking" | "harsh_cornering" | "crash";
  driverIdTag?: string;
  io: Record<string, number>;
}

const firstDefined = (...values: (number | undefined)[]): number | undefined => {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
};

/** FMB-series odometer / trip odometer IO elements are reported in metres. */
const metresToKm = (metres: number): number => Math.round((metres / 1000) * 1000) / 1000;

function resolveHarshEvent(io: Record<string, number>): FmsTelemetryPayload["harshEvent"] | undefined {
  if (io[IO.CRASH] !== undefined) return "crash";
  if (io[IO.HARSH_BRAKING] !== undefined) return "harsh_braking";
  if (io[IO.HARSH_ACCEL] !== undefined) return "harsh_acceleration";
  if (io[IO.HARSH_CORNERING] !== undefined) return "harsh_cornering";
  return undefined;
}

export function formatRecordedAt(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace("T", " ").substring(0, 19);
}

/**
 * Maps a decoded AVL record into the FMS `/api/v1/gps/positions` payload shape.
 */
export function mapRecordToFmsPayload(imei: string, record: AvlRecord): FmsTelemetryPayload {
  const { io, gps } = record;

  const ignition = io[IO.IGNITION] !== undefined ? io[IO.IGNITION] : io[IO.MOVEMENT] ? 1 : 0;
  const zoneId = firstDefined(io[IO.GEOFENCE_ZONE_1], io[IO.GEOFENCE_ZONE_2]);

  const payload: FmsTelemetryPayload = {
    deviceIdentifier: imei,
    lat: gps.lat,
    lon: gps.lon,
    speed: gps.speed,
    heading: gps.angle,
    ignition: ignition ? 1 : 0,
    odometer: io[IO.ODOMETER] !== undefined ? metresToKm(io[IO.ODOMETER]) : 0,
    altitude: gps.altitude,
    source: "teltonika",
    recordedAt: formatRecordedAt(record.timestamp),
    io,
  };

  const battery = firstDefined(io[IO.BATTERY_LEVEL]);
  if (battery !== undefined) payload.battery = battery;

  if (io[IO.IGNITION] !== undefined) payload.ignitionSource = "io_239";
  else if (io[IO.MOVEMENT] !== undefined) payload.ignitionSource = "io_240";

  if (io[IO.MOVEMENT] !== undefined) payload.movementSource = "io_240";

  const gsmSignal = firstDefined(io[IO.GSM_SIGNAL]);
  if (gsmSignal !== undefined) payload.gsmSignal = gsmSignal;

  const externalVoltage = firstDefined(io[IO.EXTERNAL_VOLTAGE]);
  if (externalVoltage !== undefined) payload.externalVoltage = externalVoltage;

  if (zoneId !== undefined) {
    payload.geofenceZoneId = String(zoneId);
    // Convention: a reported zone value of 0 means the device is currently
    // outside all configured geofences.
    payload.geofenceStatus = zoneId ? "inside" : "exit";
  }

  if (io[IO.TRIP_ODOMETER] !== undefined) payload.tripOdometer = metresToKm(io[IO.TRIP_ODOMETER]);

  const fuelLevel = firstDefined(io[IO.FUEL_LEVEL], io[IO.FUEL_LEVEL_CAN]);
  if (fuelLevel !== undefined) payload.fuelLevelPct = fuelLevel;

  const engineRpm = firstDefined(io[IO.ENGINE_RPM]);
  if (engineRpm !== undefined) payload.engineRpm = engineRpm;

  const engineHours = firstDefined(io[IO.ENGINE_HOURS]);
  if (engineHours !== undefined) payload.engineHours = engineHours;

  const driverIdTag = firstDefined(io[IO.BLE_DRIVER_ID], io[IO.IBUTTON_ID]);
  if (driverIdTag !== undefined) payload.driverIdTag = String(driverIdTag);

  const harshEvent = resolveHarshEvent(io);
  if (harshEvent) payload.harshEvent = harshEvent;

  return payload;
}

export async function forwardTelemetry(
  payload: FmsTelemetryPayload,
  config: TeltonikaRelayConfig,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const target = `${config.fmsUrl}/api/v1/gps/positions`;
  const res = await fetchImpl(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.fmsApiKey },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function handleAvlPacket(
  imei: string,
  data: Buffer,
  config: TeltonikaRelayConfig,
  onForward?: (payload: FmsTelemetryPayload, result: { ok: boolean; status: number; body: unknown }) => void
): Promise<number> {
  const packet = parseAvlPacket(data);
  for (const record of packet.records) {
    const payload = mapRecordToFmsPayload(imei, record);
    try {
      const result = await forwardTelemetry(payload, config);
      onForward?.(payload, result);
      if (!result.ok) {
        console.error(`FMS rejected telemetry for ${imei} (HTTP ${result.status})`, result.body);
      }
    } catch (err: any) {
      console.error(`Failed to forward telemetry for ${imei}:`, err?.message || err);
    }
  }
  return packet.records.length;
}

interface SessionState {
  imei?: string;
  buffer: Buffer;
}

/**
 * Creates the Teltonika AVL TCP server. Devices connect and send their IMEI
 * handshake (length-prefixed ASCII), receive 0x01, then stream length-prefixed
 * AVL data packets and receive a 4-byte record-count acknowledgement.
 */
export function createTeltonikaServer(
  config: TeltonikaRelayConfig,
  onForward?: (payload: FmsTelemetryPayload, result: { ok: boolean; status: number; body: unknown }) => void
): net.Server {
  const server = net.createServer((socket) => {
    const state: SessionState = { buffer: Buffer.alloc(0) };
    console.log(`Teltonika device connected from ${socket.remoteAddress}`);

    socket.on("data", async (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);

      try {
        // IMEI handshake
        if (!state.imei) {
          if (state.buffer.length < 2) return;
          const imeiLen = state.buffer.readUInt16BE(0);
          if (state.buffer.length < 2 + imeiLen) return;
          state.imei = state.buffer.subarray(2, 2 + imeiLen).toString("ascii");
          state.buffer = state.buffer.subarray(2 + imeiLen);
          console.log(`Teltonika IMEI handshake: ${state.imei}`);
          socket.write(Buffer.from([0x01]));
        }

        // AVL data packets (preamble + length + payload)
        while (state.buffer.length >= 8) {
          const preamble = state.buffer.readUInt32BE(0);
          if (preamble !== 0) {
            throw new Error(`Invalid AVL preamble: 0x${preamble.toString(16)}`);
          }
          const dataLength = state.buffer.readUInt32BE(4);
          if (state.buffer.length < 8 + dataLength) break;

          const data = state.buffer.subarray(8, 8 + dataLength);
          state.buffer = state.buffer.subarray(8 + dataLength);

          const count = await handleAvlPacket(state.imei, data, config, onForward);
          const ack = Buffer.alloc(4);
          ack.writeUInt32BE(count, 0);
          socket.write(ack);
          console.log(`Accepted ${count} record(s) from ${state.imei}`);
        }
      } catch (err: any) {
        console.error(`AVL decode error from ${state.imei || socket.remoteAddress}:`, err?.message || err);
      }
    });

    socket.on("error", (err) => console.error("Teltonika socket error:", err.message));
    socket.on("close", () => console.log(`Teltonika device disconnected (${state.imei || socket.remoteAddress})`));
  });

  return server;
}

function startHealthServer(config: TeltonikaRelayConfig): void {
  const app = express();
  app.use(cors());
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "Teltonika FMS Telemetry Relay", protocol: "TCP/AVL Codec 8/8E", targetFmsUrl: config.fmsUrl });
  });
  app.listen(config.healthPort, () => {
    console.log(`Teltonika relay health endpoint on port ${config.healthPort}`);
  });
}

export function startRelay(): net.Server {
  const config = loadConfig();
  const server = createTeltonikaServer(config);
  server.listen(config.port, () => {
    console.log(`Teltonika AVL TCP relay listening on port ${config.port}`);
    console.log(`Codec 8 / Codec 8 Extended supported; forwarding to ${config.fmsUrl}/api/v1/gps/positions`);
  });
  startHealthServer(config);
  return server;
}

if (require.main === module) {
  startRelay();
}
