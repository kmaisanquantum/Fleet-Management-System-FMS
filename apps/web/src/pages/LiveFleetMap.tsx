import { useEffect, useState } from "react";

/**
 * Live Fleet Map — embeds the MeshSat map UI.
 *
 * `meshsat.dspng.space` is protected by HTTP Basic auth, which a browser cannot
 * send from inside an `<iframe>`. The FMS backend therefore proxies the map at
 * `/api/meshsat-map/map`, injecting the credential server-side, and rewrites the
 * page's asset/data URLs to flow back through the proxy. We authenticate the
 * iframe navigation with the FMS JWT as `?fms_token=` (an iframe cannot set an
 * `Authorization` header); the proxy exchanges it for a short-lived cookie so the
 * map's own data-endpoint polls stay authenticated.
 *
 * For unauthenticated deployments (e.g. a MeshSat instance with no password),
 * set `VITE_MESHSAT_MAP_URL` to bypass the proxy and embed that URL directly.
 */
const PROXY_MAP_PATH = "/api/meshsat-map/map";
const OVERRIDE_MAP_URL = import.meta.env.VITE_MESHSAT_MAP_URL as string | undefined;

export default function LiveFleetMap() {
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [missingAuth, setMissingAuth] = useState(false);

  useEffect(() => {
    if (OVERRIDE_MAP_URL) {
      setMapUrl(OVERRIDE_MAP_URL);
      return;
    }
    const token = localStorage.getItem("fms_access_token");
    if (!token) {
      setMissingAuth(true);
      return;
    }
    setMapUrl(`${PROXY_MAP_PATH}?fms_token=${encodeURIComponent(token)}`);
  }, []);

  return (
    <div className="space-y-4">
      {/* Page Title */}
      <div>
        <h1 className="text-2xl font-bold text-ink-100">Live Fleet Map</h1>
        <p className="text-sm text-ink-400">Live vehicle tracking provided by the MeshSat map</p>
      </div>

      {missingAuth && (
        <p className="text-sm text-amber-400">
          Sign in to load the live map — the MeshSat map is proxied through the FMS and requires an
          authenticated session.
        </p>
      )}

      {/* MeshSat map (embedded via the FMS proxy) */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-hidden h-[calc(100vh-200px)] min-h-[520px]">
        {mapUrl ? (
          <iframe src={mapUrl} title="MeshSat Live Map" className="w-full h-full border-0" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-400 text-sm">
            {missingAuth ? "Live map unavailable" : "Loading live map…"}
          </div>
        )}
      </div>
    </div>
  );
}
