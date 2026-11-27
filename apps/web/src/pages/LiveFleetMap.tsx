import { useCallback, useEffect, useRef, useState } from "react";
import { getToken, isTokenExpiring, refreshAccessToken, subscribeToken } from "../api/client";

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
 * Access tokens live for 15 minutes. This page keeps the map alive across that
 * boundary: it refreshes the FMS token before expiry and rolls the proxy's
 * short-lived cookie forward via `/api/meshsat-map/session`, so the map never
 * starts rendering `{"error":"Invalid or expired token"}`.
 *
 * For unauthenticated deployments (e.g. a MeshSat instance with no password),
 * set `VITE_MESHSAT_MAP_URL` to bypass the proxy and embed that URL directly.
 */
const PROXY_MAP_PATH = "/api/meshsat-map/map";
const MAP_SESSION_PATH = "/api/meshsat-map/session";
const OVERRIDE_MAP_URL = import.meta.env.VITE_MESHSAT_MAP_URL as string | undefined;

/** How often to check whether the access token is close to expiring. */
const REFRESH_CHECK_MS = 30_000;
/** Refresh this long before expiry so the map's polls never hit a dead token. */
const REFRESH_SKEW_MS = 2 * 60_000;

async function rollMapSession(token: string): Promise<void> {
  try {
    await fetch(`${MAP_SESSION_PATH}?fms_token=${encodeURIComponent(token)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // Keep the previous cookie; the periodic refresh will retry shortly.
  }
}

export default function LiveFleetMap() {
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [missingAuth, setMissingAuth] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const iframeLoadedRef = useRef(false);
  const reloadInFlightRef = useRef(false);

  useEffect(() => {
    if (OVERRIDE_MAP_URL) {
      setMapUrl(OVERRIDE_MAP_URL);
      return;
    }

    let cancelled = false;
    void (async () => {
      let token = getToken();
      if (isTokenExpiring(token)) token = await refreshAccessToken();
      if (cancelled) return;
      if (!token) {
        setMissingAuth(true);
        return;
      }
      iframeLoadedRef.current = true;
      setMapUrl(`${PROXY_MAP_PATH}?fms_token=${encodeURIComponent(token)}`);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (OVERRIDE_MAP_URL) return;

    return subscribeToken((token) => {
      if (!token) {
        iframeLoadedRef.current = false;
        setMapUrl(null);
        setMissingAuth(true);
        return;
      }
      setMissingAuth(false);
      if (iframeLoadedRef.current) {
        void rollMapSession(token);
      } else {
        iframeLoadedRef.current = true;
        setMapUrl(`${PROXY_MAP_PATH}?fms_token=${encodeURIComponent(token)}`);
      }
    });
  }, []);

  useEffect(() => {
    if (OVERRIDE_MAP_URL) return;

    const id = window.setInterval(() => {
      const token = getToken();
      if (token && isTokenExpiring(token, REFRESH_SKEW_MS)) void refreshAccessToken();
    }, REFRESH_CHECK_MS);
    return () => window.clearInterval(id);
  }, []);

  const reloadMap = useCallback(async () => {
    if (OVERRIDE_MAP_URL || reloadInFlightRef.current) return;
    reloadInFlightRef.current = true;
    try {
      let token = getToken();
      if (isTokenExpiring(token)) token = await refreshAccessToken();
      if (!token) {
        setMissingAuth(true);
        setMapUrl(null);
        return;
      }
      setMissingAuth(false);
      await rollMapSession(token);
      iframeLoadedRef.current = true;
      setMapError(null);
      // The cache-buster forces a fresh iframe navigation while keeping the
      // fresh token in the proxy URL.
      setMapUrl(`${PROXY_MAP_PATH}?fms_token=${encodeURIComponent(token)}&retry=${Date.now()}`);
    } finally {
      reloadInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (OVERRIDE_MAP_URL) return;

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const type = event.data?.type;
      if (type === "fms-map-auth-error") {
        setMapError("The live map session expired. Reconnecting…");
        void reloadMap();
      } else if (type === "fms-map-tile-error") {
        setMapError("Some map tiles could not be loaded. Check your connection and retry.");
      } else if (type === "fms-map-ready") {
        setMapError(null);
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [reloadMap]);

  return (
    <div className="space-y-4">
      {/* Page Title */}
      <div>
        <h1 className="text-2xl font-bold text-ink-100">Live Fleet Map</h1>
      </div>

      {missingAuth && (
        <p className="text-sm text-amber-400">
          Sign in to load the live map — the map is proxied through the FMS and requires an
          authenticated session.
        </p>
      )}

      {mapError && (
        <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-amber-400/40 bg-amber-400/10 text-amber-300 text-xs">
          <span>{mapError}</span>
          <button onClick={() => void reloadMap()} className="btn-secondary text-xs px-3 py-1.5 whitespace-nowrap">
            Retry
          </button>
        </div>
      )}

      {/* MeshSat map (embedded via the FMS proxy) */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-hidden h-[calc(100vh-200px)] min-h-[520px]">
        {mapUrl ? (
          <iframe src={mapUrl} title="Live Fleet Map" className="w-full h-full border-0" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-400 text-sm">
            {missingAuth ? "Live map unavailable" : "Loading live map…"}
          </div>
        )}
      </div>
    </div>
  );
}
