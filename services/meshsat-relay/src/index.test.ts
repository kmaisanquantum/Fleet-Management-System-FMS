import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Server } from "http";

/**
 * MeshSat relay tests.
 *
 * The relay module is imported dynamically *after* the environment is set so
 * its module-scope config (ingest token, FMS URL) is captured for the test run.
 * The Express app is exercised on an ephemeral port; the outbound FMS forward
 * is checked with a mocked fetch. Remote command queuing lives on the
 * meshsat.dspng.space VPS, so this relay has no /api/cmd route.
 */

const INGEST_TOKEN = "test-relay-ingest-token";

let server: Server;
let baseUrl: string;

let normalizeMeshSatPayload: (body: any) => any;
let forwardToFms: (normalized: any) => Promise<{ status: number; body: any; via: string }>;

/** Minimal Response-like object for the mocked fetch. */
function fakeResponse(ok: boolean, status: number, body = "{}") {
  return {
    ok,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

/** Real fetch, captured before any stub, so the test HTTP client still works. */
const realFetch = globalThis.fetch;

describe("MeshSat relay", () => {
  beforeAll(async () => {
    process.env.TELEMETRY_INGEST_TOKEN = INGEST_TOKEN;
    process.env.FMS_URL = "https://fms.test";

    const mod = await import("./index");
    normalizeMeshSatPayload = mod.normalizeMeshSatPayload;
    forwardToFms = mod.forwardToFms;

    await new Promise<void>((resolve) => {
      server = mod.app.listen(0, () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /* ----------------------- payload normalization ------------------ */

  it("normalizes a Teltonika FMB125 payload", () => {
    const n = normalizeMeshSatPayload({
      imei: "354018115690145",
      records: [
        {
          gps: { latitude: -9.44, longitude: 147.18, speed: 45, angle: 271, satellites: 9 },
          io: { ignition: 1, totalOdometer: 123456, gsmSignal: 4 },
          timestamp: "2026-03-28T11:00:00Z",
        },
      ],
    });
    expect(n).not.toBeNull();
    expect(n.deviceIdentifier).toBe("354018115690145");
    expect(n.lat).toBeCloseTo(-9.44);
    expect(n.lon).toBeCloseTo(147.18);
    expect(n.speed).toBe(45);
    expect(n.heading).toBe(271);
    expect(n.ignition).toBe(1);
    expect(n.recordedAt).toBe("2026-03-28 11:00:00");
  });

  it("rejects a payload missing the identifier or coordinates", () => {
    expect(normalizeMeshSatPayload({ imei: "123" })).toBeNull();
    expect(normalizeMeshSatPayload(null)).toBeNull();
  });

  /* --------------------------- forwarding ------------------------- */

  it("forwards telemetry to the Bearer ingest endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(true, 201, '{"data":{}}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await forwardToFms({
      deviceIdentifier: "354018115690145",
      lat: -9.44,
      lon: 147.18,
      speed: 45,
      satellites: 9,
      ignition: 1,
      recordedAt: "2026-03-28 11:00:00",
      fuelLevelPct: 62.5,
    });

    expect(result.via).toBe("ingest");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://fms.test/api/telemetry/ingest");
    expect((opts as any).headers.Authorization).toBe(`Bearer ${INGEST_TOKEN}`);
    const body = JSON.parse((opts as any).body);
    expect(body.imei).toBe("354018115690145");
    expect(body.speed_kmh).toBe(45);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("falls back to the legacy x-api-key positions endpoint when ingest is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(false, 404, '{"error":"not found"}'))
      .mockResolvedValueOnce(fakeResponse(true, 201, '{"data":{}}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await forwardToFms({ deviceIdentifier: "354018115694907", lat: -9.44, lon: 147.18, speed: 10 });

    expect(result.via).toBe("positions");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, opts] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("https://fms.test/api/v1/gps/positions");
    expect((opts as any).headers["x-api-key"]).toBeTruthy();
  });

  /* ---------------------- webhook (end to end) -------------------- */

  it("accepts a Teltonika webhook and forwards it to the FMS ingest endpoint", async () => {
    // Only intercept the outbound FMS call; the test client's own request to
    // the relay under test must reach the real server.
    const fetchMock = vi.fn((url: any, opts?: any) => {
      if (String(url).startsWith("https://fms.test")) return Promise.resolve(fakeResponse(true, 201, '{"data":{}}'));
      return realFetch(url, opts);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imei: "354018115694907",
        records: [
          {
            gps: { latitude: -9.44, longitude: 147.18, speed: 12, angle: 10, satellites: 7 },
            io: { ignition: 1 },
            timestamp: "2026-03-28T11:00:00Z",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.via).toBe("ingest");
    // The mock also sees the test client's own request to the relay; pick the
    // outbound FMS forward.
    const forwardCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith("https://fms.test"));
    expect(forwardCall).toBeDefined();
    const [url, opts] = forwardCall!;
    expect(String(url)).toBe("https://fms.test/api/telemetry/ingest");
    expect((opts as any).headers.Authorization).toBe(`Bearer ${INGEST_TOKEN}`);
    expect(JSON.parse((opts as any).body).imei).toBe("354018115694907");
  });
});
