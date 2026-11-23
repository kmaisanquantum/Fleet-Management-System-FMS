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
  // A single leading slash is a root-relative FMS path; `//` starts an absolute
  // third-party URL, and already-proxied paths are left untouched.
  out = out.replace(/(src|href|action)=("|')\/(?!\/|api\/meshsat-map)/gi, `$1=$2${PROXY_PREFIX}/`);
  out = out.replace(/fetch\((["'])\/(?!\/|api\/meshsat-map)/gi, `fetch($1${PROXY_PREFIX}/`);
  out = out.replace(/url\((["']?)\/(?!\/|api\/meshsat-map)/gi, `url($1${PROXY_PREFIX}/`);
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
        "user-agent": PROXY_USER_AGENT,
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
