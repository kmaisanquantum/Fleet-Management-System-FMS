import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { telemetryApi, TelemetryLatest } from "../api/telemetry";

const DEFAULT_CENTER: [number, number] = [-9.4438, 147.1803];
const TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, ' +
  "Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, " +
  "&copy; OpenStreetMap contributors, and the GIS User Community";

type VehicleState = "moving" | "idle" | "stationary" | "offline";

const STATE_STYLE: Record<VehicleState, { label: string; color: string; pill: string; dot: string }> = {
  moving: { label: "Moving", color: "#2DD4A7", pill: "bg-emerald-500/15 text-emerald-400", dot: "beacon-green" },
  idle: { label: "Idle", color: "#F5A623", pill: "bg-amber-400/15 text-amber-400", dot: "beacon-yellow" },
  stationary: { label: "Stationary", color: "#8A97AC", pill: "bg-base-600 text-ink-300", dot: "beacon-grey" },
  offline: { label: "Offline", color: "#EF4B4B", pill: "bg-signal-red/15 text-signal-red", dot: "beacon-red" },
};

function vehicleState(vehicle: TelemetryLatest): VehicleState {
  if (!vehicle.online) return "offline";
  const computed = (vehicle.computed_status ?? "").toLowerCase();
  if (computed.includes("moving") || (vehicle.speed ?? 0) > 5) return "moving";
  if (computed.includes("idle") || vehicle.ignition === 1) return "idle";
  return "stationary";
}

function fmtTime(value: string | null): string {
  if (!value) return "—";
  const hasZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(value);
  const normalized = hasZone ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function MapFocus({
  focusKey,
  points,
  selected,
}: {
  focusKey: string;
  points: [number, number][];
  selected: [number, number] | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (selected) {
      map.flyTo(selected, 14, { duration: 0.6 });
      return;
    }
    if (points.length === 1) {
      map.setView(points[0], 12);
    } else if (points.length > 1) {
      map.fitBounds(points, { padding: [40, 40], maxZoom: 12 });
    }
    // focusKey captures the current point set; depending on the arrays would
    // re-fit the map on every 15s poll even when nothing moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, map]);

  return null;
}

export default function FleetLiveMap() {
  const [vehicles, setVehicles] = useState<TelemetryLatest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | VehicleState>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await telemetryApi.latest();
      setVehicles(res.data);
      setError(null);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || "Failed to load live positions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return vehicles.filter((vehicle) => {
      const state = vehicleState(vehicle);
      if (statusFilter !== "all" && state !== statusFilter) return false;
      if (!term) return true;
      return [vehicle.vehicle_number, vehicle.registration_number, vehicle.imei]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
  }, [vehicles, search, statusFilter]);

  const located = filtered.filter((vehicle) => vehicle.lat !== null && vehicle.lon !== null);
  const locatedCount = vehicles.filter((vehicle) => vehicle.lat !== null && vehicle.lon !== null).length;
  const markerOrder: Record<VehicleState, number> = { offline: 0, stationary: 1, idle: 2, moving: 3 };
  const markers = [...located].sort((a, b) => {
    if (a.vehicle_id === selectedId) return 1;
    if (b.vehicle_id === selectedId) return -1;
    return markerOrder[vehicleState(a)] - markerOrder[vehicleState(b)];
  });
  const points = located.map((vehicle) => [vehicle.lat!, vehicle.lon!] as [number, number]);
  const selected = vehicles.find((vehicle) => vehicle.vehicle_id === selectedId) ?? null;
  const selectedPoint =
    selected && selected.lat !== null && selected.lon !== null
      ? ([selected.lat, selected.lon] as [number, number])
      : null;
  const focusKey = selectedPoint
    ? `selected:${selectedPoint[0]},${selectedPoint[1]}`
    : `all:${points.map((point) => point.join(",")).join("|")}`;

  const counts = useMemo(() => {
    const next: Record<VehicleState, number> = { moving: 0, idle: 0, stationary: 0, offline: 0 };
    for (const vehicle of vehicles) next[vehicleState(vehicle)] += 1;
    return next;
  }, [vehicles]);

  return (
    <div className="flex flex-col xl:flex-row gap-4">
      <aside className="panel xl:w-80 shrink-0 flex flex-col overflow-hidden max-h-[calc(100vh-200px)] min-h-[520px]">
        <div className="p-3 border-b border-base-700 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-ink-500">Fleet Live Map</div>
              <div className="text-sm font-semibold text-ink-100">
                {vehicles.length} vehicle{vehicles.length === 1 ? "" : "s"}
              </div>
            </div>
            <button onClick={() => void load()} className="btn-secondary text-xs px-3 py-1.5" disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vehicle / registration / IMEI…"
            className="input text-xs bg-base-900 border-base-700 text-ink-100"
          />
          <div className="flex flex-wrap gap-1">
            {(["all", "moving", "idle", "stationary", "offline"] as const).map((key) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={`px-2 py-1 rounded text-[10px] font-medium ${
                  statusFilter === key ? "bg-amber-400 text-base-950" : "bg-base-800 text-ink-400 hover:text-ink-100"
                }`}
              >
                {key === "all" ? "All" : STATE_STYLE[key].label}
                {key !== "all" ? ` ${counts[key]}` : ""}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-ink-500">
            {lastRefresh
              ? `Updated ${lastRefresh.toLocaleTimeString()} · ${locatedCount} with GPS fix · auto-refresh 15s`
              : "Waiting for positions…"}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-base-800">
          {filtered.length === 0 ? (
            <div className="p-4 text-xs text-ink-500">No vehicles match this filter.</div>
          ) : (
            filtered.map((vehicle) => {
              const state = vehicleState(vehicle);
              const style = STATE_STYLE[state];
              const active = selectedId === vehicle.vehicle_id;
              return (
                <button
                  key={vehicle.vehicle_id}
                  onClick={() => setSelectedId(vehicle.vehicle_id)}
                  className={`w-full text-left p-3 transition-colors ${active ? "bg-base-700/70" : "hover:bg-base-800/60"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-ink-100 truncate">{vehicle.vehicle_number}</div>
                      <div className="text-[10px] text-ink-500 font-mono truncate">{vehicle.registration_number}</div>
                    </div>
                    <span className={`pill ${style.pill}`}>
                      <span className={`beacon ${style.dot}`} />
                      {style.label}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-400">
                    <span>{vehicle.speed != null ? `${vehicle.speed} km/h` : "Speed —"}</span>
                    <span>{vehicle.lat != null && vehicle.lon != null ? "GPS fix" : "No fix"}</span>
                    <span>Seen {fmtTime(vehicle.last_seen_at)}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0 space-y-3">
        {error && <div className="p-3 rounded-lg bg-signal-red/10 text-signal-red text-xs">{error}</div>}
        <div className="relative bg-base-900 border border-base-700 rounded-xl overflow-hidden h-[calc(100vh-200px)] min-h-[520px]">
          <MapContainer center={DEFAULT_CENTER} zoom={11} scrollWheelZoom className="w-full h-full">
            <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
            <MapFocus focusKey={focusKey} points={points} selected={selectedPoint} />
            {markers.map((vehicle) => {
              const state = vehicleState(vehicle);
              const style = STATE_STYLE[state];
              const active = selectedId === vehicle.vehicle_id;
              return (
                <CircleMarker
                  key={vehicle.vehicle_id}
                  center={[vehicle.lat!, vehicle.lon!]}
                  radius={active ? 11 : 7}
                  pathOptions={{
                    color: active ? "#F5A623" : style.color,
                    fillColor: style.color,
                    fillOpacity: 0.85,
                    weight: active ? 3 : 2,
                  }}
                  eventHandlers={{ click: () => setSelectedId(vehicle.vehicle_id) }}
                >
                  <Popup>
                    <div className="text-xs space-y-1 min-w-[180px]">
                      <div className="font-bold text-ink-100">{vehicle.vehicle_number}</div>
                      <div className="text-ink-500">{vehicle.registration_number}</div>
                      <div>
                        <span className={`pill ${style.pill}`}>{style.label}</span>
                      </div>
                      <div>Speed: {vehicle.speed != null ? `${vehicle.speed} km/h` : "—"}</div>
                      <div>Ignition: {vehicle.ignition === 1 ? "ON" : "OFF"}</div>
                      <div>Last seen: {fmtTime(vehicle.last_seen_at)}</div>
                      <div className="flex gap-2 pt-1">
                        {vehicle.imei && (
                          <Link
                            to={`/telemetry/device/${encodeURIComponent(vehicle.imei)}`}
                            className="text-amber-400 hover:text-amber-300"
                          >
                            Device
                          </Link>
                        )}
                        {vehicle.imei && (
                          <Link
                            to={`/telemetry/device/${encodeURIComponent(vehicle.imei)}/configurator`}
                            className="text-amber-400 hover:text-amber-300"
                          >
                            Configure
                          </Link>
                        )}
                      </div>
                    </div>
                  </Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>

          {!loading && located.length === 0 && (
            <div className="absolute inset-0 z-[500] flex items-center justify-center bg-base-950/70">
              <div className="panel p-4 max-w-sm text-center">
                <div className="text-sm font-semibold text-ink-100">No live positions to plot</div>
                <p className="text-xs text-ink-500 mt-1">
                  {vehicles.length === 0
                    ? "No telemetry has been received for the vehicles you can access."
                    : "The matching vehicles have no GPS fix yet. Clear the filter or wait for the next tracker report."}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
