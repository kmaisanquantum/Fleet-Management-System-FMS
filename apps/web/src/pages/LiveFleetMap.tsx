/**
 * Live Fleet Map — embeds the standalone MeshSat map UI.
 *
 * The MeshSat public endpoint is credential-protected, so the browser cannot
 * load it directly (it would show the upstream login page) and the credential
 * must never be exposed to the browser. Instead the page embeds the FMS
 * backend's server-side proxy at `/api/meshsat-map/map`, which injects the
 * MeshSat credential upstream and strips framing headers (see
 * apps/api/src/routes/meshsatMap.ts and MESHSAT_INTEGRATION.md §7).
 *
 * The proxy sits behind FMS authentication. Because an `<iframe>` navigation
 * cannot send the `Authorization` header, the FMS access token is passed as a
 * `?token=` query parameter. `VITE_MESHSAT_MAP_URL`, when set, overrides the
 * proxy URL entirely (used to point at a different map origin).
 */
const DEFAULT_MESHSAT_MAP_URL = "/api/meshsat-map/map";

export default function LiveFleetMap() {
  const base = import.meta.env.VITE_MESHSAT_MAP_URL || DEFAULT_MESHSAT_MAP_URL;
  const token = localStorage.getItem("fms_access_token");

  // Only the same-origin proxy path needs the FMS token appended; a custom
  // VITE_MESHSAT_MAP_URL is used verbatim.
  const meshsatMapUrl =
    token && base.startsWith("/api/meshsat-map")
      ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
      : base;

  return (
    <div className="space-y-4">
      {/* Page Title */}
      <div>
        <h1 className="text-2xl font-bold text-ink-100">Live Fleet Map</h1>
        <p className="text-sm text-ink-400">Live vehicle tracking provided by the MeshSat map</p>
      </div>

      {/* MeshSat map (proxied same-origin) */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-hidden h-[calc(100vh-200px)] min-h-[520px]">
        <iframe
          src={meshsatMapUrl}
          title="MeshSat Live Map"
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
}
