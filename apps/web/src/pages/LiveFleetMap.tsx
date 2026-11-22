/**
 * Live Fleet Map — embeds the standalone MeshSat map UI.
 *
 * This replaces the previous native Leaflet/FMS telematics map: the whole page
 * is a single full-size iframe pointing at the MeshSat map web app. The URL is
 * configurable via `VITE_MESHSAT_MAP_URL` and defaults to
 * https://meshsat.dspng.space/map.
 *
 * Note: the embedded page is served over HTTPS and the MeshSat server must
 * permit framing (no `X-Frame-Options: DENY`/`SAMEORIGIN`, and a CSP
 * `frame-ancestors` that includes this origin) — see MESHSAT_INTEGRATION.md §6.
 */
const DEFAULT_MESHSAT_MAP_URL = "https://meshsat.dspng.space/map";

export default function LiveFleetMap() {
  const meshsatMapUrl = import.meta.env.VITE_MESHSAT_MAP_URL || DEFAULT_MESHSAT_MAP_URL;

  return (
    <div className="space-y-4">
      {/* Page Title */}
      <div>
        <h1 className="text-2xl font-bold text-ink-100">Live Fleet Map</h1>
        <p className="text-sm text-ink-400">Live vehicle tracking provided by the MeshSat map</p>
      </div>

      {/* MeshSat map (embedded) */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-hidden h-[calc(100vh-200px)] min-h-[520px]">
        <iframe
          src={meshsatMapUrl}
          title="MeshSat Live Fleet Map"
          className="w-full h-full border-0"
          allow="geolocation"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
    </div>
  );
}
