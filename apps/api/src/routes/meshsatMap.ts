import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";

/**
 * Server-side proxy for the MeshSat map UI.
 *
 * The MeshSat public endpoint is password-protected, so the browser can no
 * longer load https://meshsat.dspng.space/map directly in an <iframe> — it
 * would only show the upstream login page. Instead the FMS backend proxies the
 * map, and every subpath/asset under it, injecting the credential server-side
 * so it is never exposed to the browser.
 *
 * Mounted at /api/meshsat-map (see src/index.ts) behind FMS authentication, so
 * only logged-in FMS users can load the map. Responses have framing headers
 * stripped so the proxied page can be shown inside the dashboard iframe.
 */

const DEFAULT_MESHSAT_MAP_ORIGIN = "https://meshsat.dspng.space";

/** Public proxy prefix; also used when rewriting absolute MeshSat URLs. */
export const MESHSAT_MAP_PROXY_PREFIX = "/api/meshsat-map";

/** Headers that must not be forwarded verbatim (framing + hop-by-hop/encoding). */
const DROPPED_HEADERS = new Set([
  "x-frame-options",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

/** Configured upstream origin (no trailing slash), defaulting to the VPS. */
function mapOrigin(): string {
  return (process.env.MESHSAT_MAP_ORIGIN || DEFAULT_MESHSAT_MAP_ORIGIN).replace(/\/+$/, "");
}

/**
 * Upstream credential, injected server-side. HTTP Basic (`MESHSAT_MAP_AUTH` in
 * `user:pass` form) wins over a bearer token (`MESHSAT_MAP_TOKEN`). Returns null
 * when neither is configured (the proxy then forwards the request unauthenticated).
 */
export function upstreamAuthorization(): string | null {
  const basic = process.env.MESHSAT_MAP_AUTH;
  if (basic) return `Basic ${Buffer.from(basic).toString("base64")}`;
  const token = process.env.MESHSAT_MAP_TOKEN;
  if (token) return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
  return null;
}

/** Remove the `frame-ancestors` directive so the proxied page can be framed. */
export function stripFrameAncestors(csp: string): string {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0 && !/^frame-ancestors\b/i.test(directive))
    .join("; ");
}

/**
 * Copy upstream response headers, dropping framing (`X-Frame-Options`, CSP
 * `frame-ancestors`) and encoding/hop-by-hop headers that must be recomputed
 * locally.
 */
export function sanitizeUpstreamHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROPPED_HEADERS.has(k)) return;
    if (k === "content-security-policy") {
      const stripped = stripFrameAncestors(value);
      if (stripped) out[k] = stripped;
      return;
    }
    out[k] = value;
  });
  return out;
}

/**
 * Rewrite absolute (`https://meshsat.dspng.space/...`) and protocol-relative
 * (`//meshsat.dspng.space/...`) URLs to the proxy path so the map's assets are
 * requested through this backend instead of hitting MeshSat directly.
 */
export function rewriteMeshSatUrls(
  body: string,
  origins: string[],
  proxyPrefix: string = MESHSAT_MAP_PROXY_PREFIX
): string {
  let out = body;
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    out = out.split(url.origin).join(proxyPrefix);
    out = out.split(`//${url.host}`).join(proxyPrefix);
  }
  return out;
}

/** Whether a response body should be treated as text (and URL-rewritten). */
function isTextual(contentType: string): boolean {
  return /text\/|javascript|application\/json|application\/xml|\+xml/i.test(contentType);
}

const router = Router();

/**
 * FMS authentication for the map proxy. The FMS access token is normally sent
 * as `Authorization: Bearer <token>`, but an `<iframe>` navigation cannot set
 * request headers, so the same JWT may also arrive as `?token=`/`?access_token=`.
 * Requests carrying no valid FMS token are rejected with 401 either way.
 */
export function requireMapAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    const q = req.query.token ?? req.query.access_token;
    if (typeof q === "string" && q) {
      req.headers.authorization = `Bearer ${q}`;
    }
  }
  return requireAuth(req, res, next);
}

router.all("*", requireMapAuth, async (req: Request, res: Response) => {
  const origin = mapOrigin();
  const method = req.method.toUpperCase();
  const headers: Record<string, string> = {};
  if (typeof req.headers.accept === "string") headers.accept = req.headers.accept;
  if (typeof req.headers["accept-language"] === "string") {
    headers["accept-language"] = req.headers["accept-language"];
  }

  // Never forward the caller's FMS token upstream — inject the map credential.
  const auth = upstreamAuthorization();
  if (auth) headers.authorization = auth;

  const init: {
    method: string;
    headers: Record<string, string>;
    redirect: "manual";
    body?: string | Uint8Array;
  } = {
    method,
    headers,
    redirect: "manual",
  };

  // Best-effort request body forward for non-idempotent methods.
  if (!["GET", "HEAD"].includes(method) && req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      init.body = req.body;
    } else if (typeof req.body === "string") {
      init.body = req.body;
    } else {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(req.body);
    }
  }

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(`${origin}${req.url}`, init);
  } catch {
    return res.status(502).json({ error: "MeshSat map upstream unreachable" });
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const origins = Array.from(new Set([origin, DEFAULT_MESHSAT_MAP_ORIGIN]));
  const outHeaders = sanitizeUpstreamHeaders(upstream.headers);

  // Redirects must point back through the proxy, never at MeshSat directly.
  if (outHeaders.location) {
    outHeaders.location = rewriteMeshSatUrls(outHeaders.location, origins);
  }

  res.status(upstream.status);
  for (const [key, value] of Object.entries(outHeaders)) res.setHeader(key, value);

  if (method === "HEAD") return res.end();

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length > 0 && isTextual(contentType)) {
    return res.send(Buffer.from(rewriteMeshSatUrls(buffer.toString("utf-8"), origins), "utf-8"));
  }
  return res.send(buffer);
});

export default router;
