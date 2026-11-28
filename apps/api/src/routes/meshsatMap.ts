import { Router } from "express";
import type { Request, Response as ExpressResponse, NextFunction } from "express";
import { Readable } from "stream";
import { verifyAccessToken } from "../middleware/auth";

/**
 * Server-side proxy for the MeshSat map.
 *
 * `meshsat.dspng.space` is protected by **HTTP Basic auth** (username + password).
 * A browser cannot send a Basic `Authorization` header from inside an `<iframe>`,
 * so the FMS backend proxies the map here and injects the credential server-side.
 *
 * Everything after the `/api/meshsat-map` mount is forwarded verbatim, so
 * `/api/meshsat-map/map` → `<MESHSAT_MAP_ORIGIN>/map` and
 * `/api/meshsat-map/api/positions` → `<MESHSAT_MAP_ORIGIN>/api/positions` (the
 * data endpoint the map's inline script polls). HTML responses have their
 * MeshSat-absolute and root-relative URLs rewritten to the proxy prefix, while
 * absolute URLs to *other* origins (e.g. `*.openstreetmap.org` tiles,
 * `unpkg.com`) are left untouched so the browser fetches them directly. Framing
 * headers are stripped so the page renders inside the FMS iframe.
 *
 * Note: absolute-URL WebSocket/SSE connections opened by the map's inline script
 * cannot be rewritten by an HTTP proxy — see MESHSAT_INTEGRATION.md §7 for the
 * token-param alternative if the map depends on them.
 */

const DEFAULT_MESHSAT_MAP_ORIGIN = "https://meshsat.dspng.space";
const PROXY_PREFIX = "/api/meshsat-map";

/**
 * Identifying User-Agent sent upstream. Tile servers such as OpenStreetMap
 * require a descriptive agent; requests that still reach the proxy (e.g. a
 * root-relative tile path on MeshSat) are forwarded with this header rather
 * than an anonymous one.
 */
const PROXY_USER_AGENT = "FleetManagementSystem/1.0 (fleet.dspng.tech)";

/** Leaflet version used by the upstream map; assets are proxied to avoid CDN blocks. */
const LEAFLET_VERSION = "1.9.4";
const LEAFLET_ASSET_PATHS = new Set([
  "leaflet.css",
  "leaflet.js",
  "images/marker-icon.png",
  "images/marker-icon-2x.png",
  "images/marker-shadow.png",
  "images/layers.png",
  "images/layers-2x.png",
]);
const LEAFLET_ASSET_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
};

/** Cookie that carries the FMS JWT for the map's same-origin sub-requests. */
export const MAP_COOKIE_NAME = "fms_map_token";
const MAP_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

/** Configured map origin (no trailing slash), defaulting to the VPS. */
function mapOrigin(): string {
  return (process.env.MESHSAT_MAP_ORIGIN || DEFAULT_MESHSAT_MAP_ORIGIN).replace(/\/+$/, "");
}

/** `Authorization: Basic <base64(user:pass)>` from `MESHSAT_MAP_AUTH`, or undefined. */
function upstreamAuthorization(): string | undefined {
  const auth = process.env.MESHSAT_MAP_AUTH;
  if (!auth) return undefined;
  return `Basic ${Buffer.from(auth).toString("base64")}`;
}

/** Minimal cookie reader (avoids pulling in cookie-parser for one value). */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Auth for the proxied map. The FMS JWT may arrive as:
 *  - a `Bearer` header (XHR/fetch callers),
 *  - `?fms_token=` on the iframe's initial navigation (an iframe cannot set
 *    headers), in which case a session cookie is also set, or
 *  - the `fms_map_token` cookie set above, so the map's own data-endpoint polls
 *    stay authenticated.
 */
export function requireMapAuth(req: Request, res: ExpressResponse, next: NextFunction) {
  const header = req.headers.authorization;
  const queryToken =
    typeof req.query.fms_token === "string" && req.query.fms_token ? req.query.fms_token : undefined;
  const cookieToken = readCookie(req, MAP_COOKIE_NAME);

  // A Bearer header is authoritative (XHR/fetch callers). For iframe navigations
  // the query token is preferred because a valid one also refreshes the cookie,
  // but a stale URL token must not shadow a fresh cookie set by /session.
  const candidates: { token: string; fromQuery: boolean }[] = [];
  if (header?.startsWith("Bearer ")) {
    candidates.push({ token: header.slice("Bearer ".length), fromQuery: false });
  } else {
    if (queryToken) candidates.push({ token: queryToken, fromQuery: true });
    if (cookieToken) candidates.push({ token: cookieToken, fromQuery: false });
  }

  for (const candidate of candidates) {
    try {
      req.user = verifyAccessToken(candidate.token);
      // A query token (iframe navigation) and the dedicated /session call both
      // establish the cookie. The SPA uses /session with a Bearer header so the
      // JWT never has to appear in the iframe URL or proxy access logs.
      if (candidate.fromQuery || req.path === "/session") {
        res.cookie(MAP_COOKIE_NAME, candidate.token, {
          httpOnly: true,
          sameSite: "lax",
          secure: req.secure,
          path: PROXY_PREFIX,
          maxAge: MAP_COOKIE_MAX_AGE_MS,
        });
      }
      return next();
    } catch {
      // Try the next credential.
    }
  }

  return res.status(401).json({ error: candidates.length ? "Invalid or expired token" : "Missing FMS token" });
}

/**
 * Copy upstream headers, dropping `X-Frame-Options` and the CSP `frame-ancestors`
 * directive (so the iframe renders) plus hop-by-hop/length headers (`fetch`
 * transparently decompresses, so the upstream `content-encoding`/`content-length`
 * no longer match the body).
 */
export function sanitizeUpstreamHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "x-frame-options") return;
    if (k === "content-security-policy") {
      const cleaned = value
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d && !d.toLowerCase().startsWith("frame-ancestors"))
        .join("; ");
      if (cleaned) out["content-security-policy"] = cleaned;
      return;
    }
    if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding" || k === "connection") {
      return;
    }
    // Never let the upstream set cookies on the FMS origin: it could overwrite
    // `fms_map_token` itself (or another path-scoped FMS cookie).
    if (k === "set-cookie") return;
    out[k] = value;
  });
  return out;
}

/**
 * Rewrite MeshSat-absolute URLs and root-relative `src`/`href`/`action`/
 * `fetch(`/`url(` references to the proxy prefix so assets and data calls flow
 * back through the proxy. Already-prefixed paths are left untouched.
 *
 * Absolute URLs to any *other* origin are deliberately preserved so the browser
 * fetches them directly — `*.openstreetmap.org` tiles, `unpkg.com` assets, and
 * other third-party hosts. Routing OSM tiles through the proxy would fetch them
 * server-side, which violates OSM's tile usage policy and makes OSM return its
 * "Access blocked" placeholder (HTTP 200). A protocol-relative `//host/...`
 * reference is an absolute third-party URL too, so it is left alone as well.
 */
export function rewriteMeshSatUrls(html: string, origin: string): string {
  let out = html.split(origin).join(PROXY_PREFIX);
  // The upstream map loads Leaflet from unpkg. Serve those assets through the
  // proxy so browsers or network policies that block third-party CDNs still
  // render the map.
  for (const scheme of ["https://", "http://", "//"]) {
    out = out
      .split(`${scheme}unpkg.com/leaflet@${LEAFLET_VERSION}/dist/`)
      .join(`${PROXY_PREFIX}/vendor/leaflet/`);
  }
  // A single leading slash is a root-relative FMS path; `//` starts an absolute
  // third-party URL, and already-proxied paths are left untouched.
  out = out.replace(/(src|href|action)=("|')\/(?!\/|api\/meshsat-map)/gi, `$1=$2${PROXY_PREFIX}/`);
  out = out.replace(/fetch\((["'])\/(?!\/|api\/meshsat-map)/gi, `fetch($1${PROXY_PREFIX}/`);
  out = out.replace(/url\((["']?)\/(?!\/|api\/meshsat-map)/gi, `url($1${PROXY_PREFIX}/`);
  return out;
}

const router = Router();

/**
 * The upstream map has used keyless OSM and CARTO basemaps. OSM answers this
 * deployment with `403 Access blocked`; CARTO renders "API KEY REQUIRED"
 * watermarks without a key. Rewrite both to a CDN-backed provider. Override
 * `MESHSAT_MAP_TILE_URL` / `MESHSAT_MAP_TILE_ATTRIBUTION` to use a licensed key.
 */
const DEFAULT_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const DEFAULT_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, ' +
  'Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, ' +
  '&copy; OpenStreetMap contributors, and the GIS User Community';

function mapTileUrl(): string {
  return process.env.MESHSAT_MAP_TILE_URL?.trim() || DEFAULT_TILE_URL;
}

function mapTileAttribution(): string {
  return process.env.MESHSAT_MAP_TILE_ATTRIBUTION?.trim() || DEFAULT_TILE_ATTRIBUTION;
}

/** Swap the upstream basemap URL/attribution without touching MeshSat's VPS. */
export function applyTileSource(html: string): string {
  const tileUrl = mapTileUrl();
  const attribution = mapTileAttribution();

  let out = html.replace(
    /https?:\/\/[^"'\s)]*(?:openstreetmap|cartocdn|cartodb)[^"'\s)]*\{z\}[^"'\s)]*\.png/gi,
    () => tileUrl,
  );
  out = out.replace(/attribution:\s*(['"])(.*?)\1/gi, (match, quote: string, value: string) => {
    if (!/(?:openstreetmap|carto)/i.test(value)) return match;
    const escaped = quote === "'" ? attribution.replace(/'/g, "\\'") : attribution.replace(/"/g, '\\"');
    return `attribution: ${quote}${escaped}${quote}`;
  });
  return out;
}

/**
 * Adds a small same-origin client shim to the proxied map document:
 *  - keeps the legacy `?fms_token=` fallback for clients that still put the JWT
 *    in the iframe URL (normal sessions authenticate with the HttpOnly cookie);
 *  - falls back from the Esri Street basemap to Esri Topo and then OSM if a
 *    tile fails, instead of leaving broken-tile errors in the map;
 *  - notifies the parent FMS page about auth/tile failures so it can show a
 *    friendly retry banner rather than raw error text.
 */
export function injectMapClientHardening(html: string): string {
  const script = `<script>(function () {
  var token = null;
  try { token = new URLSearchParams(location.search).get('fms_token'); } catch (e) {}
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        var url;
        if (typeof input === 'string') url = new URL(input, location.href);
        else if (input instanceof Request) url = new URL(input.url);
        else url = new URL(String(input), location.href);
        if (token && url.origin === location.origin && url.pathname.indexOf('/api/meshsat-map/') === 0 && !url.searchParams.has('fms_token')) {
          url.searchParams.set('fms_token', token);
          if (typeof input === 'string') input = url.pathname + url.search;
          else if (input instanceof Request) input = new Request(url.toString(), input);
          else input = url.toString();
        }
      } catch (e) {}
      return origFetch(input, init).then(function (res) {
        if (res.status === 401 || res.status === 403) {
          var hud = document.getElementById('hud');
          if (hud) hud.textContent = 'Map session expired. Reconnecting...';
          try { window.parent.postMessage({ type: 'fms-map-auth-error', status: res.status }, location.origin); } catch (e) {}
        }
        return res;
      });
    };
  }
  document.addEventListener('error', function (event) {
    var img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.classList || !img.classList.contains('leaflet-tile')) return;
    var src = img.getAttribute('src') || '';
    if (src.indexOf('World_Street_Map') !== -1 && !img.dataset.fmsRetry) {
      img.dataset.fmsRetry = '1';
      img.src = src + (src.indexOf('?') === -1 ? '?' : '&') + 'fms_retry=' + Date.now();
      return;
    }
    if (src.indexOf('World_Street_Map') !== -1 && !img.dataset.fmsTopo) {
      img.dataset.fmsTopo = '1';
      img.src = src.replace('/World_Street_Map/', '/World_Topo_Map/');
      return;
    }
    if (src.indexOf('arcgisonline.com') !== -1 && !img.dataset.fmsOsm) {
      img.dataset.fmsOsm = '1';
      var m = src.match(/\\/tile\\/(\\d+)\\/(\\d+)\\/(\\d+)(?:\\?|$)/);
      if (m) { img.src = 'https://tile.openstreetmap.org/' + m[1] + '/' + m[3] + '/' + m[2] + '.png'; return; }
    }
    if (img.dataset.fmsNotified) return;
    img.dataset.fmsNotified = '1';
    img.classList.add('fms-tile-failed');
    try { window.parent.postMessage({ type: 'fms-map-tile-error' }, location.origin); } catch (e) {}
  }, true);
  document.addEventListener('load', function (event) {
    var img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.classList || !img.classList.contains('leaflet-tile')) return;
    if (img.classList.contains('fms-tile-failed')) return;
    try { window.parent.postMessage({ type: 'fms-map-tile-ok' }, location.origin); } catch (e) {}
  }, true);
  window.addEventListener('load', function () {
    try { window.parent.postMessage({ type: 'fms-map-ready' }, location.origin); } catch (e) {}
  });
  var style = document.createElement('style');
  style.textContent = '.leaflet-tile.fms-tile-failed{visibility:hidden}';
  document.head.appendChild(style);
})();</script>`;

  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}</head>`);
  return `${script}${html}`;
}

/**
 * Lightweight session roll-forward. The SPA calls this with a fresh access token
 * after it refreshes so the map's HttpOnly cookie is renewed without reloading
 * the iframe (which would reset the user's map position).
 */
router.get("/session", requireMapAuth, (_req: Request, res: ExpressResponse) => {
  res.status(204).end();
});

/**
 * Lightweight availability probe for the SPA. It never proxies the full map
 * document, so the client can decide between the MeshSat iframe and the native
 * FMS map without a double page load. `MESHSAT_MAP_AUTH` being absent is
 * reported as unavailable rather than surfacing a blank iframe.
 */
router.get("/health", requireMapAuth, async (_req: Request, res: ExpressResponse) => {
  const authorization = upstreamAuthorization();
  if (!authorization) {
    return res.status(503).json({
      available: false,
      configured: false,
      reason: "MESHSAT_MAP_AUTH is not configured; using the FMS live map.",
    });
  }
  try {
    const upstream = await fetch(`${mapOrigin()}/map`, {
      method: "GET",
      headers: { authorization, "user-agent": PROXY_USER_AGENT },
      signal: AbortSignal.timeout(6_000),
    });
    if (!upstream.ok) {
      return res.status(503).json({
        available: false,
        configured: true,
        status: upstream.status,
        reason: `MeshSat map returned HTTP ${upstream.status}; using the FMS live map.`,
      });
    }
    return res.json({ available: true, configured: true });
  } catch {
    return res.status(503).json({
      available: false,
      configured: true,
      reason: "MeshSat map is unreachable; using the FMS live map.",
    });
  }
});

/**
 * Leaflet assets used by the upstream map. They are fetched server-side and
 * served same-origin so a browser/network that blocks unpkg can still render
 * the map. Only the known Leaflet 1.9.4 files are accepted.
 */
router.get("/vendor/leaflet/*", requireMapAuth, async (req: Request, res: ExpressResponse) => {
  const assetPath = req.path.replace(/^\/vendor\/leaflet\//, "");
  if (!LEAFLET_ASSET_PATHS.has(assetPath)) {
    return res.status(404).json({ error: "Unknown Leaflet asset" });
  }

  const extension = assetPath.split(".").pop() || "";
  const contentType = LEAFLET_ASSET_CONTENT_TYPES[extension] || "application/octet-stream";
  const mirrors = [
    `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/${assetPath}`,
    `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/${assetPath}`,
  ];

  for (const mirror of mirrors) {
    try {
      const upstream = await fetch(mirror, {
        headers: { "user-agent": PROXY_USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok || !upstream.body) continue;
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "public, max-age=86400");
      res.setHeader("x-content-type-options", "nosniff");
      Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      return;
    } catch {
      // Try the next mirror.
    }
  }

  return res.status(502).json({ error: "Leaflet assets unavailable" });
});

// Proxy every GET under /api/meshsat-map, preserving the sub-path and query string.
router.get("*", requireMapAuth, async (req: Request, res: ExpressResponse) => {
  const origin = mapOrigin();
  const subPath = req.originalUrl.slice(req.baseUrl.length).split("?")[0] || "/";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "fms_token" || key === "retry") continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else if (value !== undefined && value !== null) params.append(key, String(value));
  }
  const query = params.toString();
  const target = `${origin}${subPath}${query ? `?${query}` : ""}`;

  const authorization = upstreamAuthorization();
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers: {
        ...(authorization ? { authorization } : {}),
        accept: (req.headers.accept as string) || "*/*",
        "user-agent": PROXY_USER_AGENT,
      },
    });
  } catch {
    return res.status(502).json({ error: "MeshSat map upstream unreachable" });
  }

  res.status(upstream.status);
  const headers = sanitizeUpstreamHeaders(upstream.headers);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  // OSM's tile service returns an "access blocked" placeholder for requests that
  // carry a Referer from this deployment. The map document's policy governs its
  // tile/subresource requests, so suppress the Referer explicitly (rather than
  // relying on helmet's default) to keep the basemap visible.
  res.setHeader("referrer-policy", "no-referrer");

  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    // Basemap/provider fixes must reach browsers immediately; stale HTML is
    // what makes a previously blocked tile provider reappear.
    res.setHeader("cache-control", "no-store");
    const html = await upstream.text();
    res.send(injectMapClientHardening(applyTileSource(rewriteMeshSatUrls(html, origin))));
    return;
  }

  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
});

export default router;
