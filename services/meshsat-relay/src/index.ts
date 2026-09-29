import dotenv from "dotenv";
import express, { Request, Response } from "express";
import cors from "cors";

dotenv.config();

const PORT = Number(process.env.PORT) || 6055;
const FMS_URL = (process.env.FMS_URL || "https://fleet.dspng.tech").replace(/\/$/, "");
const FMS_API_KEY = process.env.FMS_API_KEY || "dev-telemetry-key-12345";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "MeshSat FMS Telemetry Relay", targetFmsUrl: FMS_URL });
});

/**
 * Normalizes incoming MeshSat/Meshtastic webhook payloads into standard FMS GPS format.
 */
function normalizeMeshSatPayload(body: any): {
  deviceIdentifier: string;
  lat: number;
  lon: number;
  altitude?: number;
  battery?: number;
  speed?: number;
  heading?: number;
  recordedAt?: string;
} | null {
  if (!body || typeof body !== "object") return null;

  // Handle nested Meshtastic payload structure
  const payload = body.payload || body.data || body;

  const deviceIdentifier =
    body.fromId ||
    body.sender ||
    body.nodeId ||
    body.node_id ||
    body.mac ||
    body.deviceIdentifier ||
    payload.fromId ||
    payload.sender ||
    payload.nodeId ||
    payload.mac ||
    payload.deviceIdentifier;

  const lat = parseFloat(payload.latitude ?? payload.lat ?? body.latitude ?? body.lat);
  const lon = parseFloat(payload.longitude ?? payload.lon ?? payload.lng ?? body.longitude ?? body.lon ?? body.lng);

  if (!deviceIdentifier || isNaN(lat) || isNaN(lon)) {
    return null;
  }

  const altitude = parseFloat(payload.altitude ?? payload.alt ?? body.altitude ?? body.alt);
  const battery = parseFloat(payload.batteryLevel ?? payload.battery ?? payload.batt ?? body.batteryLevel ?? body.battery);
  const speed = parseFloat(payload.speed ?? body.speed ?? 0);
  const heading = parseFloat(payload.heading ?? payload.track ?? body.heading ?? 0);

  const rawTime = payload.time || payload.timestamp || body.time || body.timestamp;
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
    altitude: isNaN(altitude) ? undefined : altitude,
    battery: isNaN(battery) ? undefined : battery,
    speed: isNaN(speed) ? 0 : speed,
    heading: isNaN(heading) ? 0 : heading,
    recordedAt,
  };
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
        requiredFields: ["nodeId/fromId/mac", "latitude", "longitude"],
        received: req.body,
      });
    }

    const targetEndpoint = `${FMS_URL}/api/v1/gps/positions`;
    console.log(`Forwarding MeshSat telemetry for '${normalized.deviceIdentifier}' to ${targetEndpoint}...`);

    const fmsResponse = await fetch(targetEndpoint, {
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
        ignition: normalized.speed && normalized.speed > 0 ? 1 : 0,
        source: "meshsat",
        recordedAt: normalized.recordedAt,
      }),
    });

    const responseData = await fmsResponse.json().catch(() => ({}));

    if (!fmsResponse.ok) {
      console.error(`FMS returned HTTP ${fmsResponse.status}:`, responseData);
      return res.status(fmsResponse.status).json({
        error: "FMS ingest rejected payload",
        fmsStatus: fmsResponse.status,
        fmsResponse: responseData,
      });
    }

    console.log(`Successfully forwarded telemetry for '${normalized.deviceIdentifier}' to FMS.`);
    res.status(200).json({
      status: "success",
      message: "Telemetry forwarded to FMS",
      normalized,
      fmsResponse: responseData,
    });
  } catch (error: any) {
    console.error("Relay forwarding error:", error.message || error);
    res.status(500).json({
      error: "Internal relay error forwarding to FMS",
      details: error.message || String(error),
    });
  }
});

app.listen(PORT, () => {
  console.log(`MeshSat Telemetry Relay listening on port ${PORT}`);
  console.log(`Configured target FMS URL: ${FMS_URL}/api/v1/gps/positions`);
});
