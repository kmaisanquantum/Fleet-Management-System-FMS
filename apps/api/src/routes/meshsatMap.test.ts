import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { signAccessToken, AuthUser } from "../middleware/auth";
import meshsatMapRouter from "./meshsatMap";

/**
 * Tests for `GET /api/meshsat-map/*` — the server-side proxy that injects the
 * MeshSat Basic-auth credential so the map renders in a same-origin iframe.
 */

const MAP_ORIGIN = "https://meshsat.example.test";
const MAP_AUTH = "admin:hunter2";
const EXPECTED_BASIC = `Basic ${Buffer.from(MAP_AUTH).toString("base64")}`;

const realFetch = global.fetch;

let server: Server;
let baseUrl: string;
let fmsToken: string;

interface UpstreamCall {
  url: string;
  init: RequestInit;
}

/** Stub global fetch: intercept MeshSat-origin calls, pass everything else through. */
function mockUpstream(responder: (call: UpstreamCall) => Response, calls: UpstreamCall[]) {
  global.fetch = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(MAP_ORIGIN)) {
      const call = { url, init: init ?? {} };
      calls.push(call);
      return Promise.resolve(responder(call));
    }
    return realFetch(input, init);
  }) as unknown as typeof fetch;
}

describe("MeshSat map proxy", () => {
  beforeAll(async () => {
    process.env.MESHSAT_MAP_ORIGIN = MAP_ORIGIN;
    process.env.MESHSAT_MAP_AUTH = MAP_AUTH;

    const user: AuthUser = {
      id: "00000000-0000-0000-0000-000000000003",
      email: "map@dspng.tech",
      roleName: "viewer",
      airportId: null,
      clientIds: [],
    };
    fmsToken = signAccessToken(user);

    const app = express();
    app.use("/api/meshsat-map", meshsatMapRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/meshsat-map`;
  });

  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.MESHSAT_MAP_ORIGIN;
    delete process.env.MESHSAT_MAP_AUTH;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await fetch(`${baseUrl}/map`);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid FMS token with 401", async () => {
    const res = await fetch(`${baseUrl}/map?fms_token=not-a-jwt`);
    expect(res.status).toBe(401);
  });

  it("injects the upstream Basic Authorization header", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(EXPECTED_BASIC);
  });

  it("forwards the query string while dropping fms_token", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      calls,
    );
    await fetch(`${baseUrl}/api/positions?client=abc&fms_token=${fmsToken}`, {
      headers: { Authorization: `Bearer ${fmsToken}` },
    });
    expect(calls[0].url).toBe(`${MAP_ORIGIN}/api/positions?client=abc`);
  });

  it("rewrites absolute and root-relative URLs in HTML", async () => {
    const html =
      '<!doctype html><html><head><link href="/style.css">' +
      '<script src="https://meshsat.example.test/app.js"></script></head>' +
      '<body><img src="/tile.png"><script>fetch("/api/positions"); fetch(\'https://meshsat.example.test/api/live\');</script>' +
      "<style>body{background:url(/bg.png)}</style></body></html>";
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    const body = await res.text();
    expect(body).toContain('href="/api/meshsat-map/style.css"');
    expect(body).toContain('src="/api/meshsat-map/app.js"');
    expect(body).toContain('src="/api/meshsat-map/tile.png"');
    expect(body).toContain('fetch("/api/meshsat-map/api/positions")');
    expect(body).toContain("fetch('/api/meshsat-map/api/live')");
    expect(body).toContain("url(/api/meshsat-map/bg.png)");
  });

  it("strips X-Frame-Options and the CSP frame-ancestors directive", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () =>
        new Response("ok", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "x-frame-options": "DENY",
            "content-security-policy": "default-src 'self'; frame-ancestors 'none'; img-src *",
          },
        }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).not.toContain("frame-ancestors");
    expect(csp).toContain("default-src");
  });

  it("accepts the FMS JWT via ?fms_token= and sets a session cookie", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map?fms_token=${fmsToken}`);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") || "";
    expect(cookie).toContain("fms_map_token=");
    expect(cookie).toContain("HttpOnly");
  });
});
