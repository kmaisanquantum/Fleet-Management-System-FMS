import { useEffect, useState } from "react";

/**
 * Live Fleet Map — embeds the MeshSat map UI.
 *
 * The MeshSat map is password-protected but accepts a shared-secret token
 * (query param `key`). The FMS backend holds that secret and exposes a
 * tokenized URL at `GET /api/meshsat/map-url` (behind FMS auth) so the token is
 * injected server-side and never baked into this app's env/source. On mount we
 * fetch that URL and embed it; if it is unavailable we fall back to the plain
 * MeshSat URL (or `VITE_MESHSAT_MAP_URL` when configured).
 */
const FALLBACK_MAP_URL =
  import.meta.env.VITE_MESHSAT_MAP_URL || "https://meshsat.dspng.space/map";

export default function LiveFleetMap() {
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadMapUrl() {
      try {
        const token = localStorage.getItem("fms_access_token");
        const res = await fetch("/api/meshsat/map-url", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`map-url request failed (${res.status})`);
        const data = (await res.json()) as { url?: string };
        if (!data.url) throw new Error("map-url response missing url");
        if (!cancelled) setMapUrl(data.url);
      } catch {
        // Fall back to the plain (password-walled) map so the page still renders.
        if (!cancelled) {
          setMapUrl(FALLBACK_MAP_URL);
          setUsingFallback(true);
        }
      }
    }

    loadMapUrl();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* Page Title */}
      <div>
        <h1 className="text-2xl font-bold text-ink-100">Live Fleet Map</h1>
        <p className="text-sm text-ink-400">Live vehicle tracking provided by the MeshSat map</p>
      </div>

      {usingFallback && (
        <p className="text-sm text-amber-400">
          Live map token unavailable — showing the MeshSat map directly; it may prompt for a password.
        </p>
      )}

      {/* MeshSat map (embedded) */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-hidden h-[calc(100vh-200px)] min-h-[520px]">
        {mapUrl ? (
          <iframe src={mapUrl} title="MeshSat Live Map" className="w-full h-full border-0" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-400 text-sm">
            Loading live map…
          </div>
        )}
      </div>
    </div>
  );
}
