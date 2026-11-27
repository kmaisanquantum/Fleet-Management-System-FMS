import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { signAccessToken, AuthUser } from "../middleware/auth";
import meshsatMapRouter, { applyTileSource } from "./meshsatMap";

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

  it("injects the upstream Basic Authorization and User-Agent headers", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(EXPECTED_BASIC);
    expect((calls[0].init.headers as Record<string, string>)["user-agent"]).toBe(
      "FleetManagementSystem/1.0 (fleet.dspng.tech)",
    );
  });

  it("forwards the query string while dropping fms_token", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      calls,
    );
    await fetch(`${baseUrl}/api/positions?client=abc&fms_token=${fmsToken}&retry=123`, {
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

  it("proxies Leaflet assets and leaves other third-party URLs untouched", async () => {
    const html =
      '<!doctype html><html><head>' +
      '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>' +
      '<link href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">' +
      "</head><body>" +
      '<img src="https://tile.openstreetmap.org/3/4/5.png">' +
      '<img src="//tile.openstreetmap.org/3/4/5.png">' +
      '<script>fetch("//tile.openstreetmap.org/3/4/5.png");</script>' +
      "<style>body{background:url(\"https://unpkg.com/bg.png\")}</style>" +
      '<img src="/tile.png">' +
      '<script src="https://meshsat.example.test/app.js"></script>' +
      '<script>fetch("/api/positions");</script>' +
      "</body></html>";
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    const body = await res.text();

    // Leaflet is served same-origin so a blocked CDN cannot break the map.
    expect(body).toContain('src="/api/meshsat-map/vendor/leaflet/leaflet.js"');
    expect(body).toContain('href="/api/meshsat-map/vendor/leaflet/leaflet.css"');
    expect(body).not.toContain("unpkg.com/leaflet@1.9.4");

    // Other external origins (OSM tiles, non-Leaflet unpkg assets) are fetched directly.
    expect(body).toContain('src="https://tile.openstreetmap.org/3/4/5.png"');
    expect(body).toContain('src="//tile.openstreetmap.org/3/4/5.png"');
    expect(body).toContain('fetch("//tile.openstreetmap.org/3/4/5.png")');
    expect(body).toContain('url("https://unpkg.com/bg.png")');
    expect(body).not.toContain("/api/meshsat-map//");

    // MeshSat-absolute and root-relative URLs still flow back through the proxy.
    expect(body).toContain('src="/api/meshsat-map/app.js"');
    expect(body).toContain('src="/api/meshsat-map/tile.png"');
    expect(body).toContain('fetch("/api/meshsat-map/api/positions")');
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

  it("falls back to a valid cookie when the iframe URL carries a stale/invalid token", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map?fms_token=expired.token.value`, {
      headers: { Cookie: `fms_map_token=${fmsToken}` },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("rolls the map session cookie forward at /session without calling upstream", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response("should not be fetched", { status: 200, headers: { "content-type": "text/plain" } }),
      calls,
    );
    const res = await fetch(`${baseUrl}/session?fms_token=${fmsToken}`);
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie") || "").toContain("fms_map_token=");
    expect(calls).toHaveLength(0);
  });

  it("serves Leaflet assets through the proxy", async () => {
    const realFetch = global.fetch;
    global.fetch = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js")) {
        return Promise.resolve(
          new Response("/* leaflet */", { status: 200, headers: { "content-type": "application/javascript" } }),
        );
      }
      return realFetch(input, init);
    }) as unknown as typeof fetch;

    const res = await fetch(`${baseUrl}/vendor/leaflet/leaflet.js`, {
      headers: { Authorization: `Bearer ${fmsToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    expect(await res.text()).toContain("leaflet");
  });

  it("rejects unknown Leaflet asset paths", async () => {
    const res = await fetch(`${baseUrl}/vendor/leaflet/evil.js`, {
      headers: { Authorization: `Bearer ${fmsToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("requires auth for Leaflet assets", async () => {
    const res = await fetch(`${baseUrl}/vendor/leaflet/leaflet.js`);
    expect(res.status).toBe(401);
  });

  it("marks proxied map HTML as no-store", async () => {
    mockUpstream(
      () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      [],
    );
    const res = await fetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });


  it("does not forward an upstream Set-Cookie onto the FMS origin", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () =>
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain", "set-cookie": "upstream_session=abc; Path=/" },
        }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") || "").not.toContain("upstream_session");
  });

  it("serves the map HTML with a keyless CARTO basemap replaced", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () =>
        new Response(
          `<html><script>L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }).addTo(map);</script></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
      calls,
    );
    const res = await fetch(`${baseUrl}/map`, { headers: { Authorization: `Bearer ${fmsToken}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("arcgisonline.com");
    expect(html).not.toContain("cartocdn");
    expect(html).not.toContain("CARTO");
  });

  it("injects the same-origin map hardening shim", async () => {
    const calls: UpstreamCall[] = [];
    mockUpstream(
      () => new Response("<html><head></head><body><div id=\"hud\"></div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      calls,
    );
    const res = await fetch(`${baseUrl}/map?fms_token=${fmsToken}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("fms-map-auth-error");
    expect(html).toContain("fms-map-tile-error");
    expect(html).toContain("fms-map-ready");
    expect(html).toContain("World_Topo_Map");
    expect(html).toContain("tile.openstreetmap.org");
    expect(html).toContain("fms_token");
  });
});

describe("applyTileSource", () => {
  const originalUrl = process.env.MESHSAT_MAP_TILE_URL;
  const originalAttribution = process.env.MESHSAT_MAP_TILE_ATTRIBUTION;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.MESHSAT_MAP_TILE_URL;
    else process.env.MESHSAT_MAP_TILE_URL = originalUrl;
    if (originalAttribution === undefined) delete process.env.MESHSAT_MAP_TILE_ATTRIBUTION;
    else process.env.MESHSAT_MAP_TILE_ATTRIBUTION = originalAttribution;
  });

  const html = `<script>L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);</script>`;

  it("replaces blocked OSM tiles with the default CDN provider and attribution", () => {
    const out = applyTileSource(html);
    expect(out).toContain(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    );
    expect(out).not.toContain("tile.openstreetmap.org");
    expect(out).toContain("Esri");
  });

  it("replaces keyless CARTO tiles with the default CDN provider and attribution", () => {
    const carto = `<script>L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }).addTo(map);</script>`;
    const out = applyTileSource(carto);
    expect(out).toContain(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    );
    expect(out).not.toContain("cartocdn");
    expect(out).not.toContain("CARTO");
    expect(out).toContain("Esri");
  });

  it("honours MESHSAT_MAP_TILE_URL and MESHSAT_MAP_TILE_ATTRIBUTION", () => {
    process.env.MESHSAT_MAP_TILE_URL = "https://tiles.example.test/{z}/{x}/{y}.png";
    process.env.MESHSAT_MAP_TILE_ATTRIBUTION = "&copy; Example Maps";
    const out = applyTileSource(html);
    expect(out).toContain("https://tiles.example.test/{z}/{x}/{y}.png");
    expect(out).toContain("&copy; Example Maps");
    expect(out).not.toContain("tile.openstreetmap.org");
  });
});
