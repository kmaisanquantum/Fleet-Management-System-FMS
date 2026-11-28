import { useEffect, useMemo, useState } from "react";
import {
  camerasApi,
  type CameraFeed,
  type CameraFeedInput,
  type CameraOptions,
  type CameraSummary,
} from "../api/cameras";

function pgt(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-AU", { timeZone: "Pacific/Port_Moresby", hour12: false });
}

const EMPTY_FEED: {
  name: string;
  scope: CameraFeed["scope"];
  depot: string;
  vehicleId: string;
  imei: string;
  streamUrl: string;
  snapshotUrl: string;
  mode: CameraFeed["mode"];
  pollIntervalSec: string;
  isActive: boolean;
} = {
  name: "",
  scope: "vehicle",
  depot: "",
  vehicleId: "",
  imei: "",
  streamUrl: "",
  snapshotUrl: "",
  mode: "snapshot",
  pollIntervalSec: "60",
  isActive: true,
};

const MODE_LABEL: Record<CameraFeed["mode"], string> = {
  snapshot: "Snapshot",
  mjpeg: "MJPEG",
  hls: "HLS",
  webrtc: "WebRTC",
};

export default function Cameras() {
  const [feeds, setFeeds] = useState<CameraFeed[]>([]);
  const [summary, setSummary] = useState<CameraSummary | null>(null);
  const [options, setOptions] = useState<CameraOptions>({ vehicles: [], depots: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState("all");
  const [depotFilter, setDepotFilter] = useState("");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [probing, setProbing] = useState<string | null>(null);

  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<CameraFeed | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FEED });
  const [saving, setSaving] = useState(false);

  const visibleVehicles = useMemo(
    () => options.vehicles.filter((vehicle) => !depotFilter || vehicle.department === depotFilter),
    [options.vehicles, depotFilter]
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [feedRes, summaryRes, optionRes] = await Promise.all([
        camerasApi.list({
          scope: scopeFilter === "all" ? undefined : scopeFilter,
          depot: depotFilter || undefined,
          vehicleId: vehicleFilter || undefined,
          search: search || undefined,
        }),
        camerasApi.summary(),
        camerasApi.options(),
      ]);
      setFeeds(feedRes.data);
      setSummary(summaryRes.data);
      setOptions(optionRes.data);
      setImageErrors({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load camera feeds");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeFilter, depotFilter, vehicleFilter]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => setRefreshTick((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  useEffect(() => {
    if (refreshTick > 0) setImageErrors({});
  }, [refreshTick]);

  function openNew() {
    setEditing(null);
    setForm({ ...EMPTY_FEED, depot: depotFilter, vehicleId: vehicleFilter });
    setModal(true);
  }

  function openEdit(feed: CameraFeed) {
    setEditing(feed);
    setForm({
      name: feed.name,
      scope: feed.scope,
      depot: feed.depot ?? "",
      vehicleId: feed.vehicle_id ?? "",
      imei: feed.imei ?? "",
      streamUrl: feed.stream_url ?? "",
      snapshotUrl: feed.snapshot_url ?? "",
      mode: feed.mode,
      pollIntervalSec: String(feed.poll_interval_sec),
      isActive: feed.is_active,
    });
    setModal(true);
  }

  function setVehicle(vehicleId: string) {
    const vehicle = options.vehicles.find((item) => item.id === vehicleId);
    setForm((current) => ({
      ...current,
      vehicleId,
      depot: current.scope === "depot" ? current.depot : vehicle?.department ?? current.depot,
      imei: vehicle?.imei ?? current.imei,
    }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const body: CameraFeedInput = {
        name: form.name.trim(),
        scope: form.scope,
        depot: form.scope === "depot" ? form.depot.trim() || null : form.depot.trim() || null,
        vehicleId: form.scope === "vehicle" ? form.vehicleId || null : null,
        imei: form.imei.trim() || null,
        streamUrl: form.streamUrl.trim() || null,
        snapshotUrl: form.snapshotUrl.trim() || null,
        mode: form.mode,
        pollIntervalSec: Number(form.pollIntervalSec) || 60,
        isActive: form.isActive,
      };
      if (editing) {
        await camerasApi.update(editing.id, body);
        setMessage(`Camera ${body.name} updated`);
      } else {
        await camerasApi.create(body);
        setMessage(`Camera ${body.name} added`);
      }
      setModal(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save camera feed");
    } finally {
      setSaving(false);
    }
  }

  async function probe(feed: CameraFeed) {
    setProbing(feed.id);
    setError(null);
    setMessage(null);
    try {
      const res = await camerasApi.probe(feed.id);
      if (res.data.feed) {
        setFeeds((current) => current.map((item) => (item.id === feed.id ? res.data.feed! : item)));
      }
      if (res.data.ok) {
        setMessage(`${feed.name} is reachable (HTTP ${res.data.status})`);
      } else {
        setError(`${feed.name} is unreachable: ${res.data.error ?? "unknown error"}`);
      }
      const summaryRes = await camerasApi.summary();
      setSummary(summaryRes.data);
      setRefreshTick((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Camera probe failed");
    } finally {
      setProbing(null);
    }
  }

  async function remove(feed: CameraFeed) {
    if (!window.confirm(`Remove camera feed "${feed.name}"?`)) return;
    setError(null);
    setMessage(null);
    try {
      await camerasApi.remove(feed.id);
      setMessage(`Camera ${feed.name} removed`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove camera feed");
    }
  }

  function snapshotUrl(feed: CameraFeed): string | null {
    const base =
      feed.snapshot_url ||
      (feed.mode === "mjpeg" || feed.mode === "snapshot" ? feed.stream_url : null);
    if (!base) return null;
    return `${base}${base.includes("?") ? "&" : "?"}t=${refreshTick}`;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Cameras</h1>
          <p className="text-sm text-ink-400 mt-1">
            Depot and vehicle camera feeds with non-blocking snapshot cards, connection status and offline alerts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-ink-300 px-3 py-2 rounded-lg border border-base-700 bg-base-900">
            <input type="checkbox" className="accent-amber-400" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            Auto-refresh snapshots
          </label>
          <button className="btn-secondary text-xs px-4 py-2" onClick={() => void load()}>Refresh list</button>
          <button className="btn-primary text-xs px-4 py-2" onClick={openNew}>+ Add camera</button>
        </div>
      </div>

      {error && <div className="p-3 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}
      {message && <div className="p-3 rounded-lg bg-signal-green/10 text-signal-green text-sm">{message}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Feeds</div>
          <div className="font-data text-2xl font-semibold text-ink-100 mt-1">{summary?.total ?? feeds.length}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Active</div>
          <div className="font-data text-2xl font-semibold text-ink-100 mt-1">{summary?.active ?? 0}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Online</div>
          <div className="font-data text-2xl font-semibold text-signal-green mt-1">{summary?.online ?? 0}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Offline</div>
          <div className="font-data text-2xl font-semibold text-signal-red mt-1">{summary?.offline ?? 0}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">With errors</div>
          <div className="font-data text-2xl font-semibold text-amber-400 mt-1">{summary?.with_errors ?? 0}</div>
        </div>
      </div>

      <div className="panel p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 items-end">
          <div>
            <label className="label">Scope</label>
            <select className="input text-xs" value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)}>
              <option value="all">All scopes</option>
              <option value="depot">Depot</option>
              <option value="vehicle">Vehicle</option>
            </select>
          </div>
          <div>
            <label className="label">Depot</label>
            <select className="input text-xs" value={depotFilter} onChange={(event) => { setDepotFilter(event.target.value); setVehicleFilter(""); }}>
              <option value="">All depots</option>
              {options.depots.map((depot) => <option key={depot} value={depot}>{depot}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Vehicle</label>
            <select className="input text-xs" value={vehicleFilter} onChange={(event) => setVehicleFilter(event.target.value)}>
              <option value="">All vehicles</option>
              {visibleVehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicle_number} · {vehicle.registration_number}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Search</label>
            <div className="flex gap-2">
              <input className="input text-xs" placeholder="Name or depot" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} />
              <button className="btn-secondary text-xs px-3 py-2" onClick={() => void load()}>Go</button>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="panel p-10 text-center text-ink-400">Loading cameras…</div>
      ) : feeds.length === 0 ? (
        <div className="panel p-10 text-center text-ink-500">No camera feeds match the current filters.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {feeds.map((feed) => {
            const src = snapshotUrl(feed);
            const imageError = imageErrors[feed.id];
            return (
              <div key={feed.id} className="panel overflow-hidden">
                <div className="relative bg-black aspect-video flex items-center justify-center">
                  {imageError ? (
                    <div className="text-center px-4">
                      <div className="text-3xl mb-2">📷</div>
                      <div className="text-xs text-ink-400">Snapshot unavailable</div>
                      <div className="text-[10px] text-ink-500 mt-1">The camera may be offline; the page is still usable.</div>
                    </div>
                  ) : feed.mode === "hls" && feed.stream_url ? (
                    <video key={`${feed.id}-${refreshTick}`} src={feed.stream_url} className="w-full h-full object-contain" controls muted playsInline />
                  ) : feed.mode === "webrtc" && feed.stream_url ? (
                    <div className="text-center px-4">
                      <div className="text-3xl mb-2">🎥</div>
                      <a href={feed.stream_url} target="_blank" rel="noreferrer" className="text-amber-400 hover:text-amber-300 text-xs">
                        Open WebRTC stream
                      </a>
                    </div>
                  ) : src ? (
                    <img
                      key={`${feed.id}-${refreshTick}`}
                      src={src}
                      alt={feed.name}
                      className="w-full h-full object-contain"
                      onError={() => setImageErrors((current) => ({ ...current, [feed.id]: true }))}
                    />
                  ) : (
                    <div className="text-xs text-ink-500">No snapshot or stream URL</div>
                  )}
                  <div className="absolute top-2 left-2 flex gap-1">
                    <span className={`pill ${feed.status === "online" ? "bg-signal-green/90 text-black" : feed.status === "offline" ? "bg-signal-red/90 text-white" : "bg-base-700 text-ink-200"}`}>
                      {feed.status}
                    </span>
                    <span className="pill bg-black/70 text-ink-200">{MODE_LABEL[feed.mode]}</span>
                  </div>
                </div>
                <div className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-ink-100">{feed.name}</div>
                      <div className="text-[11px] text-ink-500">
                        {feed.scope === "depot" ? `Depot · ${feed.depot ?? "—"}` : `Vehicle · ${feed.vehicle_number ?? "—"}`}
                        {feed.imei ? ` · ${feed.imei}` : ""}
                      </div>
                    </div>
                    {!feed.is_active && <span className="pill bg-base-700 text-ink-400">inactive</span>}
                  </div>
                  <div className="text-[11px] text-ink-400">
                    <div>Last seen: {pgt(feed.last_seen_at)}</div>
                    <div>Last check: {pgt(feed.last_checked_at)}</div>
                    {feed.last_error && <div className="text-signal-red mt-1 break-words">{feed.last_error}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button className="btn-secondary text-[11px] px-2.5 py-1.5" onClick={() => void probe(feed)} disabled={probing === feed.id}>
                      {probing === feed.id ? "Checking…" : "Refresh snapshot"}
                    </button>
                    {feed.stream_url && (
                      <a className="btn-secondary text-[11px] px-2.5 py-1.5" href={feed.stream_url} target="_blank" rel="noreferrer">Open stream</a>
                    )}
                    <button className="text-amber-400 hover:text-amber-300 text-[11px]" onClick={() => openEdit(feed)}>Edit</button>
                    <button className="text-signal-red hover:text-red-300 text-[11px]" onClick={() => void remove(feed)}>Remove</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-base-900 border border-base-700 rounded-xl p-6 w-full max-w-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-ink-100">{editing ? "Edit camera feed" : "Add camera feed"}</h2>
            <form onSubmit={save} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="label">Name</label>
                  <input required className="input text-xs" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </div>
                <div>
                  <label className="label">Scope</label>
                  <select className="input text-xs" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value as "depot" | "vehicle" })}>
                    <option value="vehicle">Vehicle</option>
                    <option value="depot">Depot</option>
                  </select>
                </div>
                {form.scope === "depot" ? (
                  <div>
                    <label className="label">Depot</label>
                    <input className="input text-xs" value={form.depot} onChange={(event) => setForm({ ...form, depot: event.target.value })} placeholder="e.g. Port Moresby depot" />
                  </div>
                ) : (
                  <div>
                    <label className="label">Vehicle</label>
                    <select required className="input text-xs" value={form.vehicleId} onChange={(event) => setVehicle(event.target.value)}>
                      <option value="">Select vehicle</option>
                      {options.vehicles.map((vehicle) => (
                        <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicle_number} · {vehicle.registration_number}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="label">IMEI (optional)</label>
                  <input className="input text-xs font-mono" value={form.imei} onChange={(event) => setForm({ ...form, imei: event.target.value })} />
                </div>
                <div>
                  <label className="label">Mode</label>
                  <select className="input text-xs" value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value as CameraFeed["mode"] })}>
                    <option value="snapshot">Snapshot</option>
                    <option value="mjpeg">MJPEG</option>
                    <option value="hls">HLS</option>
                    <option value="webrtc">WebRTC</option>
                  </select>
                </div>
                <div>
                  <label className="label">Poll interval (seconds)</label>
                  <input type="number" min="15" className="input text-xs" value={form.pollIntervalSec} onChange={(event) => setForm({ ...form, pollIntervalSec: event.target.value })} />
                </div>
                <div>
                  <label className="label">Snapshot URL</label>
                  <input className="input text-xs" value={form.snapshotUrl} onChange={(event) => setForm({ ...form, snapshotUrl: event.target.value })} placeholder="https://camera.local/snapshot.jpg" />
                </div>
                <div>
                  <label className="label">Stream URL</label>
                  <input className="input text-xs" value={form.streamUrl} onChange={(event) => setForm({ ...form, streamUrl: event.target.value })} placeholder="https://camera.local/stream.m3u8" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-ink-300">
                <input type="checkbox" className="accent-amber-400" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
                Feed is active (monitored for offline alerts)
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" className="btn-secondary text-xs px-4 py-2" onClick={() => setModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary text-xs px-4 py-2" disabled={saving}>{saving ? "Saving…" : "Save camera"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
