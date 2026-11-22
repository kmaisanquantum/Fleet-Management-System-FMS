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
 * absolute MeshSat URLs and root-relative URLs rewritten to the proxy prefix,
 * and framing headers are stripped so the page renders inside the FMS iframe.
 * Absolute URLs to *other* origins (OpenStreetMap tiles, unpkg scripts, ...)
 * are deliberately left untouched so the browser fetches them directly —
 * proxying them would fetch third-party assets server-side, which OSM blocks
 * as a tile-usage-policy violation.
 *
 * Note: absolute-URL WebSocket/SSE connections opened by the map's inline script
 * cannot be rewritten by an HTTP proxy — see MESHSAT_INTEGRATION.md §7 for the
 * token-param alternative if the map depends on them.
 */

const DEFAULT_MESHSAT_MAP_ORIGIN = "https://meshsat.dspng.space";
const PROXY_PREFIX = "/api/meshsat-map";

/** Cookie that carries the FMS JWT for the map's same-origin sub-requests. */
export const MAP_COOKIE_NAME = "fms_map_token";
const MAP_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Identifying User-Agent for upstream requests. Some third parties (e.g.
 * OpenStreetMap) block anonymous/default clients, so if a tile request ever
 * reaches the proxy (root-relative tile path) it is forwarded with this UA
 * rather than Node's default. The preferred fix is that tiles load directly in
 * the browser — see `rewriteMeshSatUrls`.
 */
const UPSTREAM_USER_AGENT = "FleetManagementSystem/1.0 (fleet.dspng.tech)";

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
  let token: string | undefined;
  let fromQuery = false;
  if (header?.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length);
  } else if (typeof req.query.fms_token === "string" && req.query.fms_token) {
    token = req.query.fms_token;
    fromQuery = true;
  } else {
    token = readCookie(req, MAP_COOKIE_NAME);
  }

  if (!token) return res.status(401).json({ error: "Missing FMS token" });
  try {
    req.user = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  if (fromQuery) {
    res.cookie(MAP_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      path: PROXY_PREFIX,
      maxAge: MAP_COOKIE_MAX_AGE_MS,
    });
  }
  next();
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
    out[k] = value;
  });
  return out;
}

/**
 * Rewrite MeshSat-origin absolute URLs and root-relative `src`/`href`/`action`/
 * `fetch(`/`url(` references to the proxy prefix so the map's own assets and
 * data calls flow back through the proxy. Already-prefixed paths are left
 * untouched.
 *
 * URLs that do **not** belong to the MeshSat origin are never rewritten:
 *  - absolute URLs to other origins (e.g. `https://tile.openstreetmap.org/...`,
 *    `https://unpkg.com/...`) load directly in the browser, and
 *  - protocol-relative URLs (`//host/...`) are guarded against with `(?!\/)`,
 *    since the root-relative rules below would otherwise turn `//host/x` into
 *    `/api/meshsat-map//host/x` and drag a third-party asset through the proxy.
 */
export function rewriteMeshSatUrls(html: string, origin: string): string {
  let out = html.split(origin).join(PROXY_PREFIX);
  out = out.replace(/(src|href|action)=("|')\/(?!\/)(?!api\/meshsat-map)/gi, `$1=$2${PROXY_PREFIX}/`);
  out = out.replace(/fetch\((["'])\/(?!\/)(?!api\/meshsat-map)/gi, `fetch($1${PROXY_PREFIX}/`);
  out = out.replace(/url\((["']?)\/(?!\/)(?!api\/meshsat-map)/gi, `url($1${PROXY_PREFIX}/`);
  return out;
}

const router = Router();

// Proxy every GET under /api/meshsat-map, preserving the sub-path and query string.
router.get("*", requireMapAuth, async (req: Request, res: ExpressResponse) => {
  const origin = mapOrigin();
  const subPath = req.originalUrl.slice(req.baseUrl.length).split("?")[0] || "/";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "fms_token") continue;
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
        "user-agent": UPSTREAM_USER_AGENT,
      },
    });
  } catch {
    return res.status(502).json({ error: "MeshSat map upstream unreachable" });
  }

  res.status(upstream.status);
  const headers = sanitizeUpstreamHeaders(upstream.headers);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const html = await upstream.text();
    res.send(rewriteMeshSatUrls(html, origin));
    return;
  }

  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
});

export default router;
