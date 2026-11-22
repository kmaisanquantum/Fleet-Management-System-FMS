import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { signAccessToken, AuthUser } from "../middleware/auth";
import meshsatMapRouter, {
  upstreamAuthorization,
  stripFrameAncestors,
  sanitizeUpstreamHeaders,
  rewriteMeshSatUrls,
  MESHSAT_MAP_PROXY_PREFIX,
} from "./meshsatMap";

/**
 * MeshSat map proxy tests.
 *
 * The router is mounted on a throwaway Express app on an ephemeral port so the
 * real middleware chain (FMS bearer/query-token auth, header sanitising) runs.
 * The outbound `fetch` to MeshSat is stubbed; calls to the local test server
 * fall through to the real fetch.
 */

const UPSTREAM_ORIGIN = "https://map.test";
const BASIC_USERPASS = "alice:secret";

let server: Server;
let baseUrl: string;
let fmsToken: string;

const upstreamCalls: { url: string; init: any }[] = [];
let upstreamResponse: () => Promise<Response>;

const realFetch = globalThis.fetch;

describe("MeshSat map proxy", () => {
  beforeAll(async () => {
    process.env.MESHSAT_MAP_ORIGIN = UPSTREAM_ORIGIN;
    process.env.MESHSAT_MAP_AUTH = BASIC_USERPASS;
    delete process.env.MESHSAT_MAP_TOKEN;

    const user: AuthUser = {
      id: "00000000-0000-0000-0000-000000000001",
      email: "map@dspng.tech",
      roleName: "admin",
      airportId: null,
      clientIds: [],
    };
    fmsToken = signAccessToken(user);

    upstreamResponse = () =>
      Promise.resolve(
        new Response("<html><body>map</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      );

    vi.stubGlobal(
      "fetch",
      vi.fn((url: any, init?: any) => {
        const u = String(url);
        if (u.startsWith(UPSTREAM_ORIGIN)) {
          upstreamCalls.push({ url: u, init });
          return upstreamResponse();
        }
        return realFetch(url, init);
      })
    );

    const app = express();
    app.use(express.json());
    app.use("/api/meshsat-map", meshsatMapRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/meshsat-map`;
  });

  afterAll(async () => {
    delete process.env.MESHSAT_MAP_ORIGIN;
    delete process.env.MESHSAT_MAP_AUTH;
    delete process.env.MESHSAT_MAP_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await realFetch(`${baseUrl}/map`);
    expect(res.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("rejects an invalid FMS token with 401", async () => {
    const res = await realFetch(`${baseUrl}/map?token=not-a-jwt`);
    expect(res.status).toBe(401);
  });

  it("proxies the map for an authenticated request (Authorization header)", async () => {
    upstreamCalls.length = 0;
    const res = await realFetch(`${baseUrl}/map`, {
      headers: { Authorization: `Bearer ${fmsToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("map");
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe(`${UPSTREAM_ORIGIN}/map`);
  });

  it("accepts the FMS token via ?token= (iframe cannot set headers)", async () => {
    upstreamCalls.length = 0;
    const res = await realFetch(`${baseUrl}/map?token=${encodeURIComponent(fmsToken)}`);
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("injects the Basic credential upstream and never forwards the FMS token", async () => {
    upstreamCalls.length = 0;
    await realFetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    const auth = upstreamCalls[0].init.headers.authorization;
    expect(auth).toBe(`Basic ${Buffer.from(BASIC_USERPASS).toString("base64")}`);
    expect(JSON.stringify(upstreamCalls[0].init.headers)).not.toContain(fmsToken);
  });

  it("injects a bearer credential when MESHSAT_MAP_TOKEN is set", async () => {
    const saved = process.env.MESHSAT_MAP_AUTH;
    delete process.env.MESHSAT_MAP_AUTH;
    process.env.MESHSAT_MAP_TOKEN = "vps-map-token";
    try {
      upstreamCalls.length = 0;
      await realFetch(`${baseUrl}/map?token=${encodeURIComponent(fmsToken)}`);
      expect(upstreamCalls[0].init.headers.authorization).toBe("Bearer vps-map-token");
    } finally {
      process.env.MESHSAT_MAP_AUTH = saved;
      delete process.env.MESHSAT_MAP_TOKEN;
    }
  });

  it("rewrites absolute MeshSat URLs in HTML to the proxy path", async () => {
    upstreamResponse = () =>
      Promise.resolve(
        new Response(
          `<html><head><script src="${UPSTREAM_ORIGIN}/map/static/app.js"></script></head>` +
            `<body><img src="//map.test/assets/logo.png"></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        )
      );
    const res = await realFetch(`${baseUrl}/map?token=${encodeURIComponent(fmsToken)}`);
    const html = await res.text();
    expect(html).toContain(`${MESHSAT_MAP_PROXY_PREFIX}/map/static/app.js`);
    expect(html).toContain(`${MESHSAT_MAP_PROXY_PREFIX}/assets/logo.png`);
    expect(html).not.toContain(UPSTREAM_ORIGIN);
  });

  it("strips X-Frame-Options and CSP frame-ancestors from the upstream response", async () => {
    upstreamResponse = () =>
      Promise.resolve(
        new Response("<html></html>", {
          status: 200,
          headers: {
            "content-type": "text/html",
            "x-frame-options": "DENY",
            "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
          },
        })
      );
    const res = await realFetch(`${baseUrl}/map?token=${encodeURIComponent(fmsToken)}`);
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/frame-ancestors/i);
    expect(csp).toContain("default-src 'self'");
    await res.text();
  });

  it("returns 502 when the MeshSat upstream is unreachable", async () => {
    upstreamResponse = () => Promise.reject(new Error("ECONNREFUSED"));
    const res = await realFetch(`${baseUrl}/map?token=${encodeURIComponent(fmsToken)}`);
    expect(res.status).toBe(502);
  });

  /* ------------------------------ pure helpers ------------------------------ */

  it("rewrites both absolute and protocol-relative URLs, de-duplicating origins", () => {
    const out = rewriteMeshSatUrls(
      "a https://meshsat.dspng.space/x b //meshsat.dspng.space/y",
      ["https://meshsat.dspng.space", "https://meshsat.dspng.space"]
    );
    expect(out).toBe("a /api/meshsat-map/x b /api/meshsat-map/y");
  });

  it("removes only the frame-ancestors directive from a CSP", () => {
    expect(stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *")).toBe(
      "default-src 'self'; img-src *"
    );
    expect(stripFrameAncestors("frame-ancestors *")).toBe("");
  });

  it("prefers the Basic credential over a bearer token", () => {
    const savedAuth = process.env.MESHSAT_MAP_AUTH;
    const savedToken = process.env.MESHSAT_MAP_TOKEN;
    process.env.MESHSAT_MAP_AUTH = "user:pass";
    process.env.MESHSAT_MAP_TOKEN = "tok";
    expect(upstreamAuthorization()).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    delete process.env.MESHSAT_MAP_AUTH;
    expect(upstreamAuthorization()).toBe("Bearer tok");
    delete process.env.MESHSAT_MAP_TOKEN;
    expect(upstreamAuthorization()).toBeNull();
    process.env.MESHSAT_MAP_AUTH = savedAuth;
    process.env.MESHSAT_MAP_TOKEN = savedToken;
  });

  it("drops framing/encoding headers in sanitizeUpstreamHeaders", () => {
    const out = sanitizeUpstreamHeaders(
      new Headers({
        "content-type": "text/html",
        "x-frame-options": "SAMEORIGIN",
        "content-encoding": "gzip",
        "content-security-policy": "frame-ancestors 'self'",
      })
    );
    expect(out["x-frame-options"]).toBeUndefined();
    expect(out["content-encoding"]).toBeUndefined();
    expect(out["content-type"]).toBe("text/html");
    // The only CSP directive was frame-ancestors, so the header is removed.
    expect(out["content-security-policy"]).toBeUndefined();
  });
});
