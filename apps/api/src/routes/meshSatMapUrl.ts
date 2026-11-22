import { Router } from "express";
import { requireAuth } from "../middleware/auth";

/**
 * MeshSat map URL provider.
 *
 * The MeshSat map endpoint is password-protected but accepts a shared-secret
 * token (query param `key`) so trusted clients can load `/map` — and the data
 * endpoint it polls — without the interactive password. The FMS backend holds
 * that secret in `MESHSAT_MAP_TOKEN` and hands the browser a ready-to-embed URL
 * via `GET /api/meshsat/map-url` (behind FMS auth), so the token is injected
 * server-side and never baked into the frontend env/source.
 *
 * The token is only as trustworthy as the MeshSat side validating it: the VPS
 * must reject `/map` (and its data endpoint) when `key` is missing or wrong.
 */

const DEFAULT_MESHSAT_MAP_ORIGIN = "https://meshsat.dspng.space";

/** Configured map origin (no trailing slash), defaulting to the VPS. */
function mapOrigin(): string {
  return (process.env.MESHSAT_MAP_ORIGIN || DEFAULT_MESHSAT_MAP_ORIGIN).replace(/\/+$/, "");
}

/**
 * Build the tokenized map URL, or null when the shared secret is not configured.
 * Exported for tests.
 */
export function buildMeshsatMapUrl(): string | null {
  const token = process.env.MESHSAT_MAP_TOKEN;
  if (!token) return null;
  return `${mapOrigin()}/map?key=${encodeURIComponent(token)}`;
}

const router = Router();

router.get("/map-url", requireAuth, (_req, res) => {
  const url = buildMeshsatMapUrl();
  if (!url) {
    return res.status(503).json({ error: "MESHSAT_MAP_TOKEN is not configured" });
  }
  return res.json({ url });
});

export default router;
