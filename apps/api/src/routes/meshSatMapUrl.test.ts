import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import { signAccessToken, AuthUser } from "../middleware/auth";
import meshsatMapUrlRouter, { buildMeshsatMapUrl } from "./meshSatMapUrl";

/**
 * Tests for `GET /api/meshsat/map-url` — the endpoint that hands the SPA a
 * tokenized MeshSat map URL so the shared secret stays server-side.
 */

const MAP_TOKEN = "s3cr3t+token/with=specials";
const MAP_ORIGIN = "https://meshsat.example.test";

let server: Server;
let baseUrl: string;
let fmsToken: string;

describe("MeshSat map-url endpoint", () => {
  beforeAll(async () => {
    process.env.MESHSAT_MAP_ORIGIN = MAP_ORIGIN;
    process.env.MESHSAT_MAP_TOKEN = MAP_TOKEN;

    const user: AuthUser = {
      id: "00000000-0000-0000-0000-000000000002",
      email: "map@dspng.tech",
      roleName: "fleet_manager",
      airportId: null,
      clientIds: [],
    };
    fmsToken = signAccessToken(user);

    const app = express();
    app.use(express.json());
    app.use("/api/meshsat", meshsatMapUrlRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/meshsat`;
  });

  afterAll(async () => {
    delete process.env.MESHSAT_MAP_ORIGIN;
    delete process.env.MESHSAT_MAP_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await fetch(`${baseUrl}/map-url`);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid FMS token with 401", async () => {
    const res = await fetch(`${baseUrl}/map-url`, {
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("returns the tokenized map URL for an authenticated request", async () => {
    const res = await fetch(`${baseUrl}/map-url`, {
      headers: { Authorization: `Bearer ${fmsToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe(`${MAP_ORIGIN}/map?key=${encodeURIComponent(MAP_TOKEN)}`);
    expect(body.url).toContain("key=");
  });

  it("errors cleanly (503) when MESHSAT_MAP_TOKEN is unset", async () => {
    const saved = process.env.MESHSAT_MAP_TOKEN;
    delete process.env.MESHSAT_MAP_TOKEN;
    try {
      const res = await fetch(`${baseUrl}/map-url`, {
        headers: { Authorization: `Bearer ${fmsToken}` },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/MESHSAT_MAP_TOKEN/);
    } finally {
      process.env.MESHSAT_MAP_TOKEN = saved;
    }
  });

  it("builds the URL from the configured origin and encodes the token", () => {
    expect(buildMeshsatMapUrl()).toBe(`${MAP_ORIGIN}/map?key=${encodeURIComponent(MAP_TOKEN)}`);
    const saved = process.env.MESHSAT_MAP_TOKEN;
    delete process.env.MESHSAT_MAP_TOKEN;
    expect(buildMeshsatMapUrl()).toBeNull();
    process.env.MESHSAT_MAP_TOKEN = saved;
  });
});
