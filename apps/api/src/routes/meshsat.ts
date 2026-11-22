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
 * Build the map URL: `<origin>/map?key=<token>` when the shared secret is
 * configured, otherwise the plain `<origin>/map` URL. Exported for tests.
 */
export function buildMeshsatMapUrl(): string {
  const base = `${mapOrigin()}/map`;
  const token = process.env.MESHSAT_MAP_TOKEN;
  return token ? `${base}?key=${encodeURIComponent(token)}` : base;
}

const router = Router();

// Any authenticated FMS role may fetch the map URL.
router.get("/map-url", requireAuth, (_req, res) => {
  return res.json({ url: buildMeshsatMapUrl() });
});

export default router;
