import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "net";
import http from "http";
import { createTeltonikaServer, mapRecordToFmsPayload, TeltonikaRelayConfig } from "./index";
import { AvlRecord, CODEC_8, CODEC_8_EXTENDED, encodeAvlPacket, parseAvlPacket } from "./codec";

const IMEI = "354018115690145";
const FMS_API_KEY = "test-telemetry-key";

let httpServer: http.Server;
let tcpServer: net.Server;
let tcpPort = 0;
let received: { path: string; apiKey?: string; body: any } | null = null;

beforeAll(async () => {
  received = null;

  httpServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received = {
        path: req.url || "",
        apiKey: req.headers["x-api-key"] as string | undefined,
        body: JSON.parse(raw || "{}"),
      };
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { id: "pos-1" }, message: "GPS position recorded" }));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  const httpPort = (httpServer.address() as net.AddressInfo).port;

  const config: TeltonikaRelayConfig = {
    port: 0,
    healthPort: 0,
    fmsUrl: `http://127.0.0.1:${httpPort}`,
    fmsApiKey: FMS_API_KEY,
  };

  tcpServer = createTeltonikaServer(config);
  await new Promise<void>((r) => tcpServer.listen(0, "127.0.0.1", () => r()));
  tcpPort = (tcpServer.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => tcpServer.close(() => r()));
  await new Promise<void>((r) => httpServer.close(() => r()));
});

interface HandshakeResult {
  handshakeByte: number;
  ackValue: number;
}

function sendHandshakeAndPacket(packet: Buffer): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const imeiBuf = Buffer.from(IMEI, "ascii");
    const lengthPrefix = Buffer.alloc(2);
    lengthPrefix.writeUInt16BE(imeiBuf.length, 0);
    const socket = net.connect(tcpPort, "127.0.0.1", () => {
      // FMB125 sends the length-prefixed IMEI as soon as the socket connects.
      socket.write(Buffer.concat([lengthPrefix, imeiBuf]));
    });

    let stage: "imei" | "data" = "imei";
    let buffer = Buffer.alloc(0);
    let handshakeByte = -1;

    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "imei" && buffer.length >= 1) {
        handshakeByte = buffer[0];
        buffer = buffer.subarray(1);
        stage = "data";
        socket.write(packet);
      }

      if (stage === "data" && buffer.length >= 4) {
        const ackValue = buffer.readUInt32BE(0);
        socket.end();
        resolve({ handshakeByte, ackValue });
      }
    });
  });
}

describe("Teltonika relay → FMS ingest", () => {
  it("decodes a live AVL packet and forwards it to /api/v1/gps/positions", async () => {
    const record: AvlRecord = {
      timestamp: 1774695600000,
      priority: 1,
      gps: { lon: 147.1803, lat: -9.4438, altitude: 52, angle: 180, satellites: 9, speed: 45 },
      eventIoId: 240,
      io: {
        239: 1, // ignition
        240: 1, // movement
        21: 5, // GSM signal
        66: 24000, // external voltage mV
        113: 92, // battery %
        16: 50400000, // odometer metres -> 50400 km
        389: 123400, // trip odometer metres -> 123.4 km
        30: 68, // fuel level %
        36: 2100, // engine RPM
        1023: 812, // engine hours
        385: 458921, // BLE driver id
        155: 0, // geofence zone -> 0 means outside/exit
        249: 9, // harsh braking event
      },
    };

    // Full framed packet (preamble + length + AVL array), as the FMB125 sends it.
    const framed = encodeAvlPacket([record], CODEC_8_EXTENDED);
    const { handshakeByte, ackValue } = await sendHandshakeAndPacket(framed);

    // FMB125 expects 0x01 on the IMEI handshake and a record-count ACK after data.
    expect(handshakeByte).toBe(0x01);
    expect(ackValue).toBe(1);

    expect(received).not.toBeNull();
    expect(received!.path).toBe("/api/v1/gps/positions");
    expect(received!.apiKey).toBe(FMS_API_KEY);

    const body = received!.body;
    expect(body.deviceIdentifier).toBe(IMEI);
    expect(body.source).toBe("teltonika");
    expect(body.lat).toBeCloseTo(-9.4438, 6);
    expect(body.lon).toBeCloseTo(147.1803, 6);
    expect(body.speed).toBe(45);
    expect(body.heading).toBe(180);
    expect(body.ignition).toBe(1);
    expect(body.odometer).toBe(50400);
    expect(body.tripOdometer).toBeCloseTo(123.4, 3);
    expect(body.gsmSignal).toBe(5);
    expect(body.externalVoltage).toBe(24000);
    expect(body.battery).toBe(92);
    expect(body.fuelLevelPct).toBe(68);
    expect(body.engineRpm).toBe(2100);
    expect(body.engineHours).toBe(812);
    expect(body.driverIdTag).toBe("458921");
    expect(body.geofenceZoneId).toBe("0");
    expect(body.geofenceStatus).toBe("exit");
    expect(body.harshEvent).toBe("harsh_braking");
    expect(body.io).toBeTypeOf("object");
    expect(body.recordedAt).toBe("2026-03-28 11:00:00");
  });
});

describe("AVL record → FMS payload mapping", () => {
  it("maps IO elements, odometer units, and harsh events", () => {
    const packet = parseAvlPacket(
      Buffer.from(
        "08010000019D3419CF800157B9EE78FA5EFD90003400B409002DF80A0615051E44715CEF01F001F80C03240834425DC0430F3C011003010B0000010EC40000",
        "hex"
      )
    );
    const payload = mapRecordToFmsPayload(IMEI, packet.records[0]);

    expect(packet.codecId).toBe(CODEC_8);
    expect(payload.deviceIdentifier).toBe(IMEI);
    expect(payload.source).toBe("teltonika");
    expect(payload.odometer).toBe(50400); // metres → km
    expect(payload.battery).toBe(92);
    expect(payload.gsmSignal).toBe(5);
    expect(payload.externalVoltage).toBe(24000);
    expect(payload.ignitionSource).toBe("io_239");
    expect(payload.movementSource).toBe("io_240");
    expect(payload.engineRpm).toBe(2100);
    expect(payload.harshEvent).toBe("harsh_acceleration");
  });
});
