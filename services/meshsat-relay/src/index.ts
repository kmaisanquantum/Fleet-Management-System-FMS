import dotenv from "dotenv";
import express, { Request, Response } from "express";
import cors from "cors";

dotenv.config();

const PORT = Number(process.env.PORT) || 6055;
const FMS_URL = (process.env.FMS_URL || "https://fleet.dspng.tech").replace(/\/$/, "");
const FMS_API_KEY = process.env.FMS_API_KEY || "dev-telemetry-key-12345";
/**
 * Bearer token for the canonical FMS telemetry ingest endpoint
 * (`POST /api/telemetry/ingest`). When set, telemetry is preferred to this
 * endpoint; the legacy `/api/v1/gps/positions` (x-api-key) path is kept as a
 * fallback so the relay works against either FMS deployment.
 */
const TELEMETRY_INGEST_TOKEN = process.env.TELEMETRY_INGEST_TOKEN || "";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "MeshSat FMS Telemetry Relay", targetFmsUrl: FMS_URL });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "MeshSat FMS Telemetry Relay",
    endpoints: {
      health: "GET /health",
      webhook: "POST /webhook (aliases: /webhook/meshsat, /api/v1/telemetry)",
    },
    targetFmsUrl: TELEMETRY_INGEST_TOKEN ? `${FMS_URL}/api/telemetry/ingest` : `${FMS_URL}/api/v1/gps/positions`,
    notes:
      "Remote command queuing (Codec 12) lives on the meshsat.dspng.space VPS (POST /api/cmd), not in this relay.",
  });
});

interface NormalizedTelemetry {
  deviceIdentifier: string;
  lat: number;
  lon: number;
  altitude?: number;
  battery?: number;
  speed?: number;
  heading?: number;
  satellites?: number;
  ignition?: number;
  odometer?: number;
  fuelLevelPct?: number;
  gsmSignal?: number;
  recordedAt?: string;
}

/** Returns the first candidate that parses to a finite number (also accepts numeric strings and booleans). */
function toNumber(...values: any[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "boolean") return value ? 1 : 0;
    const n = typeof value === "number" ? value : parseFloat(value);
    if (!isNaN(n)) return n;
  }
  return undefined;
}

/** Selects the most recent record from a Teltonika array payload, else returns the root object. */
function pickLatestRecord(body: any): any {
  if (Array.isArray(body)) return body[body.length - 1];
  if (Array.isArray(body.data)) return body.data[body.data.length - 1];
  if (Array.isArray(body.records)) return body.records[body.records.length - 1];
  return body;
}

/**
 * Normalizes incoming webhook payloads into the standard FMS GPS position format.
 * Supports Meshtastic/MeshSat payloads (fromId/sender/nodeId/mac) and Teltonika
 * FMB125 payloads (imei/device_id with a nested `gps` object and AVL `io` elements).
 */
function normalizeMeshSatPayload(body: any): NormalizedTelemetry | null {
  if (!body || typeof body !== "object") return null;

  // Teltonika may send a bare array of records or nest them under `data`/`records`.
  const record = pickLatestRecord(body);
  if (!record || typeof record !== "object") return null;

  // Handle nested Meshtastic payload structure.
  const payload = record.payload || record.data || record;

  const deviceIdentifier =
    body.imei ||
    body.IMEI ||
    body.device_id ||
    body.deviceId ||
    body.fromId ||
    body.sender ||
    body.nodeId ||
    body.node_id ||
    body.mac ||
    body.deviceIdentifier ||
    body.device?.imei ||
    body.device?.IMEI ||
    record.imei ||
    record.IMEI ||
    record.device_id ||
    record.deviceId ||
    record.fromId ||
    record.sender ||
    record.nodeId ||
    record.node_id ||
    record.mac ||
    record.deviceIdentifier ||
    payload.imei ||
    payload.IMEI ||
    payload.device_id ||
    payload.deviceId ||
    payload.fromId ||
    payload.sender ||
    payload.nodeId ||
    payload.mac ||
    payload.deviceIdentifier ||
    payload.device?.imei;

  // Teltonika nests GNSS fields under `gps`.
  const gps = record.gps || payload.gps || {};
  // Teltonika AVL IO elements: a nested `io` object or flat `io_####` keys.
  const io = record.io || payload.io || {};

  const lat = toNumber(gps.latitude, gps.lat, payload.latitude, payload.lat, body.latitude, body.lat);
  const lon = toNumber(gps.longitude, gps.lon, gps.lng, payload.longitude, payload.lon, payload.lng, body.longitude, body.lon, body.lng);

  if (!deviceIdentifier || lat === undefined || lon === undefined) {
    return null;
  }

  const altitude = toNumber(gps.altitude, payload.altitude, payload.alt, body.altitude, body.alt);
  const battery = toNumber(payload.batteryLevel, payload.battery, payload.batt, io.batteryVoltage, body.batteryLevel, body.battery);
  const speed = toNumber(gps.speed, payload.speed, body.speed) ?? 0;
  const heading = toNumber(gps.angle, gps.heading, payload.heading, payload.track, body.heading) ?? 0;
  const satellites = toNumber(gps.satellites, gps.sat, payload.satellites, body.satellites);
  const ignition = toNumber(io.ignition, io.ignitionStatus, record.ignition, record.io_239, payload.io_239, io["239"], record["239"]);
  const odometer = toNumber(io.totalOdometer, io.odometer, record.odometer, record.io_16, payload.io_16, io["16"]);
  const fuelLevelPct = toNumber(io.fuelLevelPct, io.fuelLevel, io.fuel_level, record.fuelLevel, record.io_30, record.io_81, io["30"], io["81"]);
  const gsmSignal = toNumber(io.gsmSignal, io.gsm_signal, io.gsm, record.gsmSignal, record.io_21, io["21"]);

  const rawTime = record.ts || record.timestamp || record.time || payload.time || payload.timestamp || body.time || body.timestamp;
  let recordedAt: string | undefined;
  if (rawTime) {
    try {
      const d = new Date(typeof rawTime === "number" ? rawTime * (rawTime < 1e11 ? 1000 : 1) : rawTime);
      if (!isNaN(d.getTime())) {
        recordedAt = d.toISOString().replace("T", " ").substring(0, 19);
      }
    } catch {}
  }

  return {
    deviceIdentifier: String(deviceIdentifier),
    lat,
    lon,
    altitude,
    battery,
    speed,
    heading,
    satellites,
    ignition,
    odometer,
    fuelLevelPct,
    gsmSignal,
    recordedAt,
  };
}

/** Converts the normalized `YYYY-MM-DD HH:MM:SS` timestamp to ISO-8601 (UTC). */
function toIso(recordedAt?: string): string {
  if (!recordedAt) return new Date().toISOString();
  const d = new Date(recordedAt.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Forwards a normalized record to the canonical FMS telemetry ingest endpoint,
 * falling back to the legacy x-api-key positions endpoint when no ingest token
 * is configured or the ingest endpoint is unavailable.
 */
async function forwardToFms(normalized: NormalizedTelemetry): Promise<{ status: number; body: any; via: string }> {
  if (TELEMETRY_INGEST_TOKEN) {
    const ingestUrl = `${FMS_URL}/api/telemetry/ingest`;
    console.log(`Forwarding telemetry for '${normalized.deviceIdentifier}' to ${ingestUrl}...`);
    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELEMETRY_INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        imei: normalized.deviceIdentifier,
        timestamp: toIso(normalized.recordedAt),
        lat: normalized.lat,
        lon: normalized.lon,
        sats: normalized.satellites ?? null,
        speed_kmh: normalized.speed ?? null,
        heading: normalized.heading ?? null,
        odometer: normalized.odometer ?? null,
        ignition: normalized.ignition ?? (normalized.speed && normalized.speed > 0 ? 1 : 0),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok || (res.status !== 404 && res.status !== 401)) {
      return { status: res.status, body, via: "ingest" };
    }
    console.warn(`Ingest endpoint returned HTTP ${res.status}; falling back to legacy positions endpoint.`);
  }

  const legacyUrl = `${FMS_URL}/api/v1/gps/positions`;
  console.log(`Forwarding telemetry for '${normalized.deviceIdentifier}' to ${legacyUrl}...`);
  const res = await fetch(legacyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": FMS_API_KEY,
    },
    body: JSON.stringify({
      deviceIdentifier: normalized.deviceIdentifier,
      lat: normalized.lat,
      lon: normalized.lon,
      altitude: normalized.altitude,
      battery: normalized.battery,
      speed: normalized.speed,
      heading: normalized.heading,
      satellites: normalized.satellites,
      // Prefer the Teltonika ignition IO element; fall back to deriving it from speed.
      ignition: normalized.ignition ?? (normalized.speed && normalized.speed > 0 ? 1 : 0),
      odometer: normalized.odometer,
      fuelLevelPct: normalized.fuelLevelPct,
      gsmSignal: normalized.gsmSignal,
      source: "meshsat",
      recordedAt: normalized.recordedAt,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, via: "positions" };
}

/**
 * POST /webhook or POST /webhook/meshsat
 * MeshSat Gateway Webhook Listener
 */
app.post(["/webhook", "/webhook/meshsat", "/api/v1/telemetry"], async (req: Request, res: Response) => {
  try {
    const normalized = normalizeMeshSatPayload(req.body);

    if (!normalized) {
      console.warn("Received invalid/unparseable MeshSat payload:", JSON.stringify(req.body));
      return res.status(400).json({
        error: "Invalid MeshSat payload format",
        requiredFields: ["nodeId/fromId/mac/imei", "latitude", "longitude"],
        received: req.body,
      });
    }

    const { status, body, via } = await forwardToFms(normalized);

    if (status >= 400) {
      console.error(`FMS (${via}) returned HTTP ${status}:`, body);
      return res.status(status).json({
        error: "FMS ingest rejected payload",
        via,
        fmsStatus: status,
        fmsResponse: body,
      });
    }

    console.log(`Successfully forwarded telemetry for '${normalized.deviceIdentifier}' to FMS via ${via}.`);
    res.status(200).json({
      status: "success",
      message: "Telemetry forwarded to FMS",
      via,
      normalized,
      fmsResponse: body,
    });
  } catch (error: any) {
    console.error("Relay forwarding error:", error.message || error);
    res.status(500).json({
      error: "Internal relay error forwarding to FMS",
      details: error.message || String(error),
    });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`MeshSat Telemetry Relay listening on port ${PORT}`);
    console.log(
      `Telemetry target: ${
        TELEMETRY_INGEST_TOKEN ? `${FMS_URL}/api/telemetry/ingest (Bearer)` : `${FMS_URL}/api/v1/gps/positions (x-api-key)`
      }`
    );
  });
}

export { app, normalizeMeshSatPayload, forwardToFms };
export type { NormalizedTelemetry };
