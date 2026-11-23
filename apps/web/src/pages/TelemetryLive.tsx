import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { telemetryApi, TelemetryLatest } from "../api/telemetry";
import { useAuth } from "../context/AuthContext";

const STATUS_STYLES: Record<string, string> = {
  moving: "bg-signal-green/15 text-signal-green",
  idle: "bg-amber-400/15 text-amber-400",
  stationary: "bg-base-600 text-ink-300",
  offline: "bg-signal-red/15 text-signal-red",
  under_maintenance: "bg-signal-red/15 text-signal-red",
  unassigned: "bg-base-600 text-ink-400",
};

function statusClass(status: string | null): string {
  return STATUS_STYLES[status || ""] || "bg-base-600 text-ink-300";
}

function fmt(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined) return "—";
  return `${value}${suffix}`;
}

function fmtTs(value: string | null | undefined): string {
  if (!value) return "never";
  return new Date(value.replace(" ", "T") + "Z").toLocaleString();
}

export default function TelemetryLive() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<TelemetryLatest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const res = await telemetryApi.latest();
      setVehicles(res.data);
      setError(null);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || "Failed to load live telemetry");
    } finally {
      setLoading(false);
    }
  }

  const filtered = vehicles.filter((v) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      v.vehicle_number?.toLowerCase().includes(q) ||
      v.registration_number?.toLowerCase().includes(q) ||
      (v.imei || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Vehicle Live Status</h1>
          <p className="text-sm text-ink-400">
            Live telemetry — position, ignition, speed, satellites and fuel level
            {user?.clientIds?.length ? " for your fleet" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search vehicle / IMEI…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input text-xs w-52 bg-base-900 border-base-700 text-ink-100"
          />
          <button onClick={load} className="btn-secondary text-xs px-3 py-2">
            Refresh
          </button>
        </div>
      </div>

      {lastRefresh && (
        <div className="text-xs text-ink-500">Last updated {lastRefresh.toLocaleTimeString()} · auto-refresh every 15s</div>
      )}

      {error && <div className="p-4 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}

      {loading ? (
        <div className="p-8 text-center text-ink-400">Loading telemetry…</div>
      ) : filtered.length === 0 ? (
        <div className="panel p-12 text-center text-ink-500">No vehicles available.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((v) => (
            <div key={v.vehicle_id} className="panel p-5 space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-display font-semibold text-ink-100">{v.vehicle_number}</div>
                  <div className="text-xs text-ink-500 font-mono">{v.registration_number}</div>
                  <div className="text-xs text-ink-400 mt-1">
                    {v.make} {v.model}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {v.online === false && (
                    <span
                      className="badge bg-signal-red/15 text-signal-red"
                      title={`Last seen ${fmtTs(v.last_seen_at)}`}
                    >
                      Offline
                    </span>
                  )}
                  <span className={`badge ${statusClass(v.computed_status)} capitalize`}>
                    {(v.computed_status || "unknown").replace(/_/g, " ")}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-ink-500 uppercase tracking-wide text-[10px]">Ignition</div>
                  <div className={`font-semibold ${v.ignition === 1 ? "text-signal-green" : "text-ink-300"}`}>
                    {v.ignition === 1 ? "ON" : "OFF"}
                  </div>
                </div>
                <div>
                  <div className="text-ink-500 uppercase tracking-wide text-[10px]">Speed</div>
                  <div className="font-data text-ink-100">{fmt(v.speed, " km/h")}</div>
                </div>
                <div>
                  <div className="text-ink-500 uppercase tracking-wide text-[10px]">Satellites</div>
                  <div className="font-data text-ink-100">{fmt(v.sats)}</div>
                </div>
                <div>
                  <div className="text-ink-500 uppercase tracking-wide text-[10px]">Fuel</div>
                  <div className="font-data text-ink-100">
                    {v.fuel_liters != null ? `${v.fuel_liters} L` : v.fuel_level_pct != null ? `${v.fuel_level_pct}%` : "—"}
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="text-ink-500 uppercase tracking-wide text-[10px]">Position</div>
                  <div className="font-mono text-ink-200">
                    {v.lat != null && v.lon != null ? `${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}` : "No fix"}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between text-[11px] text-ink-500 border-t border-base-700 pt-3 gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono">IMEI {v.imei || "—"}</span>
                  <span className={v.online === false ? "text-signal-red" : ""}>Last seen {fmtTs(v.last_seen_at)}</span>
                </div>
                {v.imei ? (
                  <Link to={`/telemetry/device/${v.imei}`} className="text-amber-400 hover:underline">
                    Device panel &rarr;
                  </Link>
                ) : (
                  <span>{v.recorded_at ? new Date(v.recorded_at.replace(" ", "T") + "Z").toLocaleString() : "Never"}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
