import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { getToken, isTokenExpiring, refreshAccessToken, subscribeToken } from "../api/client";
import FleetLiveMap from "../components/FleetLiveMap";

/**
 * Live Fleet Map — embeds the MeshSat map UI.
 *
 * `meshsat.dspng.space` is protected by HTTP Basic auth, which a browser cannot
 * send from inside an `<iframe>`. The FMS backend therefore proxies the map at
 * `/api/meshsat-map/map`, injecting the credential server-side, and rewrites the
 * page's asset/data URLs to flow back through the proxy. The page calls
 * `/api/meshsat-map/session` with a Bearer token to obtain a short-lived,
 * HttpOnly cookie, then loads the iframe without any token in its URL. The map's
 * own data-endpoint polls authenticate with that cookie.
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
const MAP_HEALTH_PATH = "/api/meshsat-map/health";
const MAP_SESSION_PATH = "/api/meshsat-map/session";
const OVERRIDE_MAP_URL = import.meta.env.VITE_MESHSAT_MAP_URL as string | undefined;

/** How often to check whether the access token is close to expiring. */
const REFRESH_CHECK_MS = 30_000;
/** Refresh this long before expiry so the map's polls never hit a dead token. */
const REFRESH_SKEW_MS = 2 * 60_000;

async function rollMapSession(token: string): Promise<void> {
  try {
    await fetch(MAP_SESSION_PATH, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // Keep the previous cookie; the periodic refresh will retry shortly.
  }
}

export default function LiveFleetMap() {
  const [mapUrl, setMapUrl] = useState<string | null>(OVERRIDE_MAP_URL ?? null);
  const [mapMode, setMapMode] = useState<"meshsat" | "native">(OVERRIDE_MAP_URL ? "meshsat" : "native");
  const [missingAuth, setMissingAuth] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [tileWarning, setTileWarning] = useState<string | null>(null);
  const iframeLoadedRef = useRef(false);
  const reloadInFlightRef = useRef(false);
  const autoFallbackRef = useRef(false);
  const authRetryCountRef = useRef(0);
  const tileErrorCountRef = useRef(0);
  const tileClearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (OVERRIDE_MAP_URL) {
      setMapUrl(OVERRIDE_MAP_URL);
      setMapMode("meshsat");
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
      await rollMapSession(token);
      if (cancelled) return;
      iframeLoadedRef.current = true;
      setMapUrl(PROXY_MAP_PATH);
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
        void rollMapSession(token).then(() => setMapUrl(PROXY_MAP_PATH));
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

  function onIframeLoad(event: SyntheticEvent<HTMLIFrameElement>) {
    try {
      const text = event.currentTarget.contentDocument?.body?.innerText ?? "";
      if (text.length < 2000 && /basic realm|invalid or expired token|missing fms token|unauthorized/i.test(text)) {
        setMapMode("native");
        setMapError("MeshSat map authentication failed; showing the FMS live map instead.");
      }
    } catch {
      // Cross-origin iframe (override mode); leave it alone.
    }
  }

  const reloadMap = useCallback(async () => {
    if (OVERRIDE_MAP_URL || reloadInFlightRef.current) return;
    reloadInFlightRef.current = true;
    try {
      let token = getToken();
      if (isTokenExpiring(token)) token = await refreshAccessToken();
      if (!token) {
        setMissingAuth(true);
        setMapUrl(null);
        setMapMode("native");
        return;
      }
      setMissingAuth(false);
      await rollMapSession(token);
      iframeLoadedRef.current = true;
      setMapError(null);
      setTileWarning(null);
      tileErrorCountRef.current = 0;
      setMapMode("meshsat");
      // The cache-buster forces a fresh iframe navigation after the session
      // cookie has been rolled forward.
      setMapUrl(`${PROXY_MAP_PATH}?retry=${Date.now()}`);
    } finally {
      reloadInFlightRef.current = false;
    }
  }, []);

  const openMeshSatMap = useCallback(async (silent = false) => {
    if (OVERRIDE_MAP_URL) {
      setMapUrl(OVERRIDE_MAP_URL);
      setMapMode("meshsat");
      return;
    }
    let token = getToken();
    if (isTokenExpiring(token)) token = await refreshAccessToken();
    if (!token) {
      setMissingAuth(true);
      setMapMode("native");
      return;
    }
    setMapError(null);
    setTileWarning(null);
    authRetryCountRef.current = 0;
    try {
      const res = await fetch(MAP_HEALTH_PATH, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const health = await res.json().catch(() => ({}));
      if (!res.ok || !health.available) {
        setMapMode("native");
        if (!silent) setMapError(health.reason || "MeshSat map is unavailable; using the FMS live map.");
        return;
      }
      await reloadMap();
    } catch {
      setMapMode("native");
      if (!silent) setMapError("MeshSat map is unreachable; using the FMS live map.");
    }
  }, [reloadMap]);

  const showNativeMap = useCallback(() => {
    setMapMode("native");
    setMapError(null);
    setTileWarning(null);
  }, []);

  const handleNativeEmpty = useCallback(() => {
    if (OVERRIDE_MAP_URL || autoFallbackRef.current || mapMode !== "native") return;
    autoFallbackRef.current = true;
    void openMeshSatMap(true);
  }, [mapMode, openMeshSatMap]);

  useEffect(() => {
    if (OVERRIDE_MAP_URL) return;

    function clearTileWarning() {
      tileErrorCountRef.current = 0;
      setTileWarning(null);
      if (tileClearTimerRef.current !== null) {
        window.clearTimeout(tileClearTimerRef.current);
        tileClearTimerRef.current = null;
      }
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const type = event.data?.type;
      if (type === "fms-map-auth-error") {
        setTileWarning(null);
        if (authRetryCountRef.current >= 2) {
          setMapMode("native");
          setMapError("The live map session expired; showing the FMS live map instead.");
          return;
        }
        authRetryCountRef.current += 1;
        setMapError("The live map session expired. Reconnecting…");
        void reloadMap();
      } else if (type === "fms-map-tile-error") {
        // One failed tile is usually transient; only surface a banner once
        // several tiles fail, and clear it automatically when tiles recover.
        tileErrorCountRef.current += 1;
        if (tileErrorCountRef.current >= 3) {
          setTileWarning("Some map tiles are retrying in the background.");
          if (tileClearTimerRef.current !== null) window.clearTimeout(tileClearTimerRef.current);
          tileClearTimerRef.current = window.setTimeout(() => setTileWarning(null), 10_000);
        }
      } else if (type === "fms-map-tile-ok") {
        if (tileErrorCountRef.current > 0) clearTileWarning();
      } else if (type === "fms-map-ready") {
        clearTileWarning();
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (tileClearTimerRef.current !== null) {
        window.clearTimeout(tileClearTimerRef.current);
        tileClearTimerRef.current = null;
      }
    };
  }, [reloadMap]);

  return (
    <div className="space-y-4">
      {/* Page Title */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Live Fleet Map</h1>
          <p className="text-xs text-ink-500 mt-1">
            {mapMode === "native"
              ? "FMS live positions · native map"
              : "MeshSat map embedded through the authenticated FMS proxy"}
          </p>
        </div>
        {mapMode === "native" && !OVERRIDE_MAP_URL && (
          <button onClick={() => void openMeshSatMap()} className="btn-secondary text-xs px-3 py-2">
            Open MeshSat map
          </button>
        )}
        {mapMode === "meshsat" && !OVERRIDE_MAP_URL && (
          <button onClick={showNativeMap} className="btn-secondary text-xs px-3 py-2">
            FMS map
          </button>
        )}
      </div>

      {missingAuth && (
        <p className="text-sm text-amber-400">
          Sign in to load the live map — the map is proxied through the FMS and requires an
          authenticated session.
        </p>
      )}

      {(mapError || tileWarning) && (
        <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-amber-400/40 bg-amber-400/10 text-amber-300 text-xs">
          <span>{mapError ?? tileWarning}</span>
          <button
            onClick={() => void (mapError && mapMode === "native" ? openMeshSatMap() : reloadMap())}
            className="btn-secondary text-xs px-3 py-1.5 whitespace-nowrap"
          >
            {mapError && mapMode === "native" ? "Try MeshSat" : "Retry"}
          </button>
        </div>
      )}

      {missingAuth ? (
        <div className="bg-base-900 border border-base-700 rounded-xl h-[calc(100vh-200px)] min-h-[520px] flex items-center justify-center text-ink-400 text-sm">
          Live map unavailable
        </div>
      ) : mapMode === "native" ? (
        <FleetLiveMap onEmptyChange={handleNativeEmpty} />
      ) : (
        <div className="bg-base-900 border border-base-700 rounded-xl overflow-hidden h-[calc(100vh-200px)] min-h-[520px]">
          {mapUrl ? (
            <iframe
              src={mapUrl}
              title="Live Fleet Map"
              className="w-full h-full border-0"
              onLoad={onIframeLoad}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-ink-400 text-sm">
              Loading live map…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
