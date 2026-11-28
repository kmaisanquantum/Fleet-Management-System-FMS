import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  telemetryApi,
  DeviceFeatures,
  DeviceCommand,
  DeviceMedia,
  IoFeature,
} from "../api/telemetry";
import {
  deviceConfigApi,
  DeviceConfig,
  DeviceConfigPreset,
  DeviceConfigUpdate,
  DeviceConfigValue,
} from "../api/deviceConfig";
import { useAuth } from "../context/AuthContext";

/** Roles allowed to dispatch remote device commands (mirrors the API guard). */
const COMMAND_ROLES = new Set(["admin", "fleet_manager"]);

/** Speed above which an ignition cut is refused (mirrors the API guard). */
const IGNITION_CUT_SPEED_LIMIT_KMH = 10;

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-amber-400/15 text-amber-400",
  sent: "bg-signal-green/15 text-signal-green",
  applied: "bg-emerald-500/15 text-emerald-400",
  acked: "bg-emerald-500/15 text-emerald-400",
  acknowledged: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-signal-red/15 text-signal-red",
  expired: "bg-base-600 text-ink-300",
};

const CONFIG_STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-400/15 text-amber-400",
  applied: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-signal-red/15 text-signal-red",
  unknown: "bg-base-600 text-ink-300",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-signal-red/15 text-signal-red",
  warning: "bg-amber-400/15 text-amber-400",
  info: "bg-base-600 text-ink-200",
};

/** Capability-driven tab keys. */
type TabKey = "immobilizer" | "fuel" | "parameters" | "camera" | "canble";

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value.replace(" ", "T") + "Z").toLocaleString();
}

function featureValue(f: IoFeature): string {
  if (f.value === null || f.value === undefined) return "—";
  if (f.value_type === "boolean") return f.value ? "ON" : "OFF";
  // Scalar IO with a unit conversion (e.g. fuel counter ml -> L) shows the
  // scaled value with the raw counter in parentheses.
  if (f.scale_factor && f.scale_factor !== 1 && f.scaled_value !== null) {
    return `${f.scaled_value} (raw ${f.value})`;
  }
  return String(f.value);
}

/** Renders the Teltonika command string a stored command dispatches, from its
 *  persisted payload. Mirrors the API's serializeCommand(). */
function serializedCommand(payloadJson: string): string {
  if (!payloadJson) return "—";
  try {
    const c = JSON.parse(payloadJson);
    switch (c.type) {
      case "setparam":
        return `setparam ${c.param_id}:${c.value}`;
      case "setdigout": {
        const index = c.dout_index ?? 1;
        const parts = ["setdigout", String(c.dout), String(index)];
        if (c.timeout !== undefined && c.timeout !== null) parts.push(String(c.timeout));
        return parts.join(" ");
      }
      case "getparam":
        return `getparam ${c.param_id}`;
      case "camreq":
        return c.channel !== undefined && c.channel !== null ? `camreq ${c.channel}` : "camreq";
      case "diagnostic":
      case "raw":
        return String(c.command);
      default:
        return payloadJson;
    }
  } catch {
    return payloadJson;
  }
}

function ConfigPresetCard({
  preset,
  category,
  children,
  disabled,
  onApply,
}: {
  preset?: DeviceConfigPreset;
  category?: string;
  children: ReactNode;
  disabled: boolean;
  onApply: () => void;
}) {
  if (!preset) return null;
  return (
    <div className="panel p-4 space-y-3">
      <div>
        {category && (
          <div className="text-[10px] uppercase tracking-wider text-amber-400/80 font-semibold">{category}</div>
        )}
        <div className="text-sm font-semibold text-ink-100">{preset.label}</div>
        <p className="text-[11px] text-ink-500 mt-0.5">{preset.description}</p>
      </div>
      <div className="space-y-2">{children}</div>
      <div className="flex items-end justify-between gap-3 pt-1">
        <span className="text-[10px] font-mono text-ink-500">
          {preset.parameters.map((p) => `${p.param_id ?? "?"} ${p.label}`).join(" · ")}
        </span>
        <button onClick={onApply} disabled={disabled} className="btn-primary text-xs px-3 py-1.5">
          Apply
        </button>
      </div>
    </div>
  );
}

export default function DeviceTelemetry() {
  const { imei } = useParams<{ imei: string }>();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const canCommand = !!user && COMMAND_ROLES.has(user.role);
  const isAdmin = user?.role === "admin";

  const [device, setDevice] = useState<DeviceFeatures | null>(null);
  const [commands, setCommands] = useState<DeviceCommand[]>([]);
  const [media, setMedia] = useState<DeviceMedia[]>([]);
  const [config, setConfig] = useState<DeviceConfig | null>(null);
  const [configInputs, setConfigInputs] = useState<Record<string, string>>({});
  const [rawParam, setRawParam] = useState({ param_id: "", value: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [tab, setTab] = useState<TabKey>(
    searchParams.get("tab") === "configuration" ? "parameters" : "fuel"
  );
  // Pending immobilizer action awaiting explicit confirmation.
  const [confirmDigout, setConfirmDigout] = useState<0 | 1 | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [confirmReason, setConfirmReason] = useState("");
  const [confirmForce, setConfirmForce] = useState(false);

  const load = useCallback(async () => {
    if (!imei) return;
    try {
      const configPromise = deviceConfigApi.get(imei).catch(() => null);
      const [featuresRes, commandsRes, mediaRes, configRes] = await Promise.all([
        telemetryApi.features(imei),
        telemetryApi.commands.list(imei),
        telemetryApi.media(imei),
        configPromise,
      ]);
      setDevice(featuresRes.data);
      setCommands(commandsRes.data);
      setMedia(mediaRes.data);
      setConfig(configRes?.data ?? null);
      setError(null);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || "Failed to load device telemetry");
    } finally {
      setLoading(false);
    }
  }, [imei]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!config) return;
    setConfigInputs((prev) => {
      const next = { ...prev };
      for (const p of config.parameters) {
        const value = p.desired_value ?? p.value;
        if (next[p.feature_key] === undefined && value !== null) next[p.feature_key] = String(value);
      }
      return next;
    });
  }, [config]);

  const fuelEvents = useMemo(
    () => (device?.events ?? []).filter((e) => e.type === "refuel" || e.type === "fuel_drain"),
    [device]
  );

  async function applyConfig(body: DeviceConfigUpdate, successMessage?: string) {
    if (!imei) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await deviceConfigApi.update(imei, body);
      setNotice(successMessage || res.message || "Configuration update queued.");
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to queue configuration update");
    } finally {
      setBusy(false);
    }
  }

  function setConfigInput(key: string, value: string) {
    setConfigInputs((prev) => ({ ...prev, [key]: value }));
  }

  async function readConfiguration() {
    if (!config || config.parameters.length === 0) {
      setError("No mapped parameters to read for this device.");
      return;
    }
    await applyConfig(
      { read: config.parameters.map((p) => p.param_id) },
      "Configuration read requested. Values update after the tracker's next MeshSat sync."
    );
  }

  async function readParameter(paramId: number) {
    await applyConfig({ read: [paramId] }, `Read request queued for parameter ${paramId}.`);
  }

  async function getDeviceInfo() {
    await applyConfig({ diagnostic: "getinfo" }, "Device info request queued.");
  }

  async function applyReportingInterval() {
    const value = Number(configInputs["reporting_interval"]);
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a valid reporting interval in seconds.");
      return;
    }
    await applyConfig({ preset: "reporting_interval", value });
  }

  async function applyIgnitionSource() {
    const value = Number(configInputs["ignition_source"]);
    if (!Number.isFinite(value)) {
      setError("Enter a valid ignition source value.");
      return;
    }
    await applyConfig({ preset: "ignition_source", value });
  }

  async function applyDataAcquisition() {
    const ignition_on = Number(configInputs["data_acquisition_ignition_on"]);
    const ignition_off = Number(configInputs["data_acquisition_ignition_off"]);
    if (!Number.isFinite(ignition_on) || ignition_on < 0 || !Number.isFinite(ignition_off) || ignition_off < 0) {
      setError("Enter valid ignition-on and ignition-off acquisition periods.");
      return;
    }
    await applyConfig({ preset: "data_acquisition", values: { ignition_on, ignition_off } });
  }

  async function applyDigitalOutput() {
    const value = Number(configInputs["digital_output_control"]);
    if (value !== 0 && value !== 1) {
      setError("Digital output must be 0 (off) or 1 (on).");
      return;
    }
    await applyConfig({ preset: "digital_output_control", value });
  }

  async function applyRawParameter() {
    const paramId = Number(rawParam.param_id);
    if (!Number.isInteger(paramId) || paramId <= 0) {
      setError("Enter a positive numeric parameter ID.");
      return;
    }
    const raw = rawParam.value.trim();
    if (!raw) {
      setError("Enter a value for the raw parameter.");
      return;
    }
    const numeric = Number(raw);
    const value: DeviceConfigValue = Number.isNaN(numeric) ? raw : numeric;
    await applyConfig({ parameters: [{ param_id: paramId, value }] });
  }

  async function sendDigout(dout: 0 | 1, reason?: string, force?: boolean) {
    if (!imei) return;
    await issue({
      imei,
      type: "setdigout",
      params: { dout },
      ...(reason ? { reason } : {}),
      ...(force ? { force } : {}),
    });
  }

  /** Opens the confirmation modal for an immobilizer action (no dispatch yet). */
  function requestDigout(dout: 0 | 1) {
    setConfirmChecked(false);
    setConfirmReason("");
    setConfirmForce(false);
    setConfirmDigout(dout);
  }

  /** Dispatches the immobilizer action once the operator has confirmed. */
  async function confirmDigoutAction() {
    if (confirmDigout === null) return;
    const dout = confirmDigout;
    const reason = confirmReason.trim();
    // The API requires a non-empty reason for an ignition cut.
    if (dout === 1 && !reason) {
      setError("A reason is required before cutting the ignition.");
      return;
    }
    const force = dout === 1 && isAdmin && confirmForce;
    setConfirmDigout(null);
    await sendDigout(dout, reason || undefined, force);
  }

  /** Read-only status command (getinfo / getgps / getver / getstatus / readio). */
  async function sendDiagnostic(command: "getinfo" | "getgps" | "getver" | "getstatus" | "readio") {
    if (!imei) return;
    await issue({ imei, type: "diagnostic", params: { command } });
  }

  /** Requests a camera snapshot on the next tracker sync. */
  async function requestCamera(channel = 1) {
    if (!imei) return;
    await issue({ imei, type: "camreq", params: { channel } });
  }

  async function issue(body: {
    imei: string;
    type: "setparam" | "setdigout" | "diagnostic" | "raw" | "camreq";
    params?: Record<string, string | number | boolean>;
    reason?: string;
    force?: boolean;
  }) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await telemetryApi.commands.issue(body);
      setNotice(res.message || "Queued / Pending Next Tracker Sync");
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to queue command");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    setError(null);
    try {
      await telemetryApi.commands.cancel(id);
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to cancel command");
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    try {
      const blob = await telemetryApi.exportCsv(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `telemetry_${imei}_${from.toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || "Export failed");
    }
  }

  if (loading) {
    return <div className="p-8 text-ink-400">Loading device telemetry…</div>;
  }

  if (!device) {
    return (
      <div className="space-y-4">
        <div className="p-4 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error || "Device not found."}</div>
        <Link to="/telemetry" className="btn-secondary text-xs px-3 py-2">&larr; Back to live status</Link>
      </div>
    );
  }

  const live = device.live;
  const capabilities = device.capabilities;

  // Current immobilizer-relevant state, decoded from the latest IO payload:
  // IO 239 = ignition state, IO 179 = DOUT1 / immobilizer output.
  const ignitionFeature = device.features.find((f) => f.io_id === 239);
  const doutFeature =
    device.features.find((f) => f.io_id === 179 && f.feature_key === "immobilizer") ??
    device.features.find((f) => f.io_id === 179);
  const ignitionOn = live?.ignition === 1 || ignitionFeature?.value === 1;
  const doutEngaged = doutFeature?.value === 1;
  const lastSpeed = live?.speed_kmh ?? null;
  const moving = lastSpeed !== null && lastSpeed > IGNITION_CUT_SPEED_LIMIT_KMH;
  const rawParamId = Number(rawParam.param_id);
  // FMB125 server/GPRS/APN parameters live in the 2000-2199 block. Changing
  // them remotely can lock the tracker out of MeshSat, so surface a warning.
  const serverParamWarning = Number.isInteger(rawParamId) && rawParamId >= 2000 && rawParamId <= 2199;

  // Capability-driven tabs: the three core tabs are always present; the camera
  // and CAN/BLE tabs appear only when the device hardware supports them.
  const tabs: { key: TabKey; label: string }[] = [
    { key: "immobilizer", label: "Immobilizer" },
    { key: "fuel", label: "Fuel & Telemetry" },
    { key: "parameters", label: "Configuration" },
  ];
  if (capabilities?.has_camera) tabs.push({ key: "camera", label: "Camera / Media" });
  if (capabilities?.has_can_j1939 || capabilities?.has_ble_sensors) tabs.push({ key: "canble", label: "CAN / BLE" });
  const activeTab: TabKey = tabs.some((t) => t.key === tab) ? tab : "fuel";

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-base-700 pb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-ink-100">{device.vehicle_number || "Device"}</h1>
            <span className="text-sm font-mono px-2 py-0.5 rounded bg-base-800 text-ink-300">{device.registration_number}</span>
            {device.device_model && (
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-base-800 text-ink-400">{device.device_model}</span>
            )}
            {device.online === false && (
              <span className="badge bg-signal-red/15 text-signal-red">Offline</span>
            )}
          </div>
          <p className="text-sm text-ink-400 mt-1 font-mono">IMEI {device.imei}</p>
          <p className={`text-xs mt-1 ${device.online === false ? "text-signal-red" : "text-ink-500"}`}>
            Last seen {fmtDate(device.last_seen_at)}
          </p>
          {lastRefresh && (
            <div className="text-xs text-ink-500 mt-1">Last updated {lastRefresh.toLocaleTimeString()} · auto-refresh every 15s</div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/device-configurator/${encodeURIComponent(device.imei)}`}
            className="btn-primary text-xs px-3 py-2"
          >
            Open Configurator Workspace
          </Link>
          <Link to="/telemetry" className="btn-secondary text-xs px-3 py-2">&larr; Back to live status</Link>
        </div>
      </div>

      {error && <div className="p-4 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}
      {notice && <div className="p-4 rounded-lg bg-amber-400/10 text-amber-400 text-sm">{notice}</div>}

      {/* Capability-driven tab bar */}
      <div className="flex flex-wrap gap-1 border-b border-base-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs font-semibold rounded-t-md transition-colors ${
              activeTab === t.key
                ? "bg-base-800 text-amber-400 border-b-2 border-amber-400"
                : "text-ink-400 hover:text-ink-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Immobilizer tab */}
      {activeTab === "immobilizer" && (
        <div className="panel p-5 space-y-4">
          <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Remote Ignition Shutdown / Restore</h2>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
            <div>
              <div className="text-ink-500 uppercase tracking-wide text-[10px]">Ignition</div>
              <div className={`font-semibold ${ignitionOn ? "text-signal-green" : "text-ink-300"}`}>
                {live || ignitionFeature ? (ignitionOn ? "ON" : "OFF") : "—"}
              </div>
            </div>
            <div>
              <div className="text-ink-500 uppercase tracking-wide text-[10px]">Immobilizer (DOUT1)</div>
              <div className={`font-semibold ${doutEngaged ? "text-signal-red" : "text-ink-300"}`}>
                {doutFeature ? (doutEngaged ? "CUT / ENGAGED" : "RELEASED") : "—"}
              </div>
            </div>
            <div>
              <div className="text-ink-500 uppercase tracking-wide text-[10px]">Last speed</div>
              <div className={`font-data ${moving ? "text-signal-red font-semibold" : "text-ink-100"}`}>
                {lastSpeed != null ? `${lastSpeed} km/h` : "—"}
              </div>
            </div>
          </div>

          {moving && (
            <div className="p-3 rounded bg-signal-red/10 text-signal-red text-xs">
              Warning: this vehicle is reporting {lastSpeed} km/h. Cutting the ignition while moving is blocked by the
              API (over {IGNITION_CUT_SPEED_LIMIT_KMH} km/h){isAdmin ? "; an admin may override it explicitly (audited)." : "."}
            </div>
          )}

          <p className="text-[11px] text-ink-500">
            Cutting the ignition immobilizes the vehicle via DOUT1. Both actions require explicit confirmation before
            the command is queued.
          </p>

          {canCommand ? (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => requestDigout(1)}
                disabled={busy}
                className="bg-signal-red/20 hover:bg-signal-red/30 text-signal-red font-semibold px-4 py-2 rounded-md transition-colors text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cut Ignition (Immobilize)
              </button>
              <button onClick={() => requestDigout(0)} disabled={busy} className="btn-secondary text-xs px-4 py-2">
                Restore Ignition
              </button>
            </div>
          ) : (
            <p className="text-[11px] text-ink-500">Your role is read-only for device commands.</p>
          )}

          {canCommand && (
            <div className="border-t border-base-800 pt-4 space-y-2">
              <div className="text-xs font-semibold text-ink-100">Diagnostics</div>
              <p className="text-[11px] text-ink-500">
                Read-only status requests; the tracker replies on its next TCP sync and the result appears in the
                command history below.
              </p>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => sendDiagnostic("getinfo")} disabled={busy} className="btn-secondary text-xs px-4 py-2">
                  Get Info
                </button>
                <button onClick={() => sendDiagnostic("getgps")} disabled={busy} className="btn-secondary text-xs px-4 py-2">
                  Get GPS
                </button>
                <button onClick={() => sendDiagnostic("getver")} disabled={busy} className="btn-secondary text-xs px-4 py-2">
                  Get Version
                </button>
                <button onClick={() => sendDiagnostic("getstatus")} disabled={busy} className="btn-secondary text-xs px-4 py-2">
                  Get Status
                </button>
                <button onClick={() => sendDiagnostic("readio")} disabled={busy} className="btn-secondary text-xs px-4 py-2">
                  Read IO
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Fuel & Telemetry tab */}
      {activeTab === "fuel" && (
        <>
          <div className="panel p-5 space-y-4">
            <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Live Status</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              <div>
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Ignition</div>
                <div className={`font-semibold ${live?.ignition === 1 ? "text-signal-green" : "text-ink-300"}`}>
                  {live ? (live.ignition === 1 ? "ON" : "OFF") : "—"}
                </div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Speed</div>
                <div className="font-data text-ink-100">{live?.speed_kmh != null ? `${live.speed_kmh} km/h` : "—"}</div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Satellites</div>
                <div className="font-data text-ink-100">{live?.sats ?? "—"}</div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Fuel</div>
                <div className="font-data text-ink-100">{live?.fuel_liters != null ? `${live.fuel_liters} L` : "—"}</div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">External voltage</div>
                <div className="font-data text-ink-100">{live?.ext_voltage_v != null ? `${live.ext_voltage_v} V` : "—"}</div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Internal battery</div>
                <div className="font-data text-ink-100">{live?.int_battery_v != null ? `${live.int_battery_v} V` : "—"}</div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Odometer</div>
                <div className="font-data text-ink-100">{live?.odometer_km != null ? `${live.odometer_km} km` : "—"}</div>
              </div>
              <div>
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Movement</div>
                <div className="text-ink-100">{live ? (live.movement === 1 ? "Moving" : "Stationary") : "—"}</div>
              </div>
              <div className="col-span-2">
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Position</div>
                <div className="font-mono text-ink-200">
                  {live?.lat != null && live?.lon != null ? `${live.lat.toFixed(5)}, ${live.lon.toFixed(5)}` : "No fix"}
                </div>
              </div>
              <div className="col-span-2">
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Last fix</div>
                <div className="text-ink-200">{fmtDate(live?.recorded_at)}</div>
              </div>
              <div className="col-span-2">
                <div className="text-ink-500 uppercase tracking-wide text-[10px]">Driver (iButton)</div>
                <div className="font-mono text-ink-200">{live?.driver_id || "—"}</div>
              </div>
            </div>
          </div>

          <div className="panel p-5 space-y-4">
            <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">IO Features</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {device.features.map((f) => (
                <div key={`${f.io_id}-${f.feature_key}`} className="p-3 rounded-lg bg-base-950 border border-base-800 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-ink-100">{f.label}</div>
                    <div className="text-[10px] text-ink-500 font-mono">
                      IO {f.io_id} · {f.feature_key}
                    </div>
                  </div>
                  <div className={`font-data text-sm ${f.value ? "text-amber-400" : "text-ink-400"}`}>{featureValue(f)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Fuel — Refuel / Drain Events</h2>
              <div className="flex gap-2">
                <button onClick={exportCsv} className="btn-secondary text-xs px-3 py-1.5">Export CSV</button>
                <button onClick={() => window.print()} className="btn-secondary text-xs px-3 py-1.5">Print</button>
              </div>
            </div>
            {fuelEvents.length === 0 ? (
              <div className="text-xs text-ink-500">No refuel or drain events recorded.</div>
            ) : (
              <table className="table-shell">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {fuelEvents.map((e) => (
                    <tr key={e.id}>
                      <td className="text-xs text-ink-400 whitespace-nowrap">{fmtDate(e.created_at)}</td>
                      <td>
                        <span className={`pill ${e.type === "refuel" ? "bg-signal-green/15 text-signal-green" : "bg-amber-400/15 text-amber-400"}`}>
                          {e.type === "refuel" ? "Refuel" : "Drain"}
                        </span>
                      </td>
                      <td className="text-xs text-ink-200">{e.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Link to="/telemetry-report" className="text-xs text-amber-400 hover:underline">Open full fuel &amp; alert report →</Link>
          </div>

          <div className="panel p-5 space-y-4">
            <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Recent Telemetry Events</h2>
            {device.events.length === 0 ? (
              <div className="text-xs text-ink-500">No telemetry events recorded.</div>
            ) : (
              <div className="space-y-2 text-xs">
                {device.events.map((e) => (
                  <div key={e.id} className="p-3 rounded-lg bg-base-950 border border-base-800 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-ink-100">
                        <span className="font-mono text-amber-400">{e.rule_code}</span> — {e.description}
                      </div>
                      <div className="text-ink-500">{fmtDate(e.created_at)}</div>
                    </div>
                    <span className={`pill ${SEVERITY_STYLES[e.severity] || "bg-base-600 text-ink-300"}`}>{e.severity}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Device configuration tab (remote Teltonika Codec 12) */}
      {activeTab === "parameters" && (
        <div className="space-y-4">
          <div className="panel p-5 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Device Configuration</h2>
                <p className="text-xs text-ink-500 max-w-2xl">
                  Remote Teltonika FMB125 configuration through the MeshSat gateway. Commands use Codec 12 and are
                  applied on the tracker's next TCP sync. Parameter IDs come from Settings → Teltonika Parameter Map.
                </p>
                <div className="text-[10px] text-ink-500 font-mono">
                  IMEI {imei} · {config?.device_model ?? device?.device_model ?? "FMB125"} · Last applied{" "}
                  {fmtDate(config?.last_applied_at ?? null)}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className={`pill ${config?.online ? "bg-emerald-500/15 text-emerald-400" : "bg-signal-red/15 text-signal-red"}`}>
                    {config?.online ? "Online" : "Offline"}
                  </span>
                  <span className="text-ink-400">Last seen {fmtDate(config?.device_last_seen_at ?? null)}</span>
                  {config?.queued_count ? (
                    <span className="text-amber-400">{config.queued_count} command(s) queued for next check-in</span>
                  ) : null}
                </div>
                {config?.last_sync_info && (
                  <div className="text-[10px] text-ink-400 font-mono break-all">
                    Last device info ({fmtDate(config.last_sync_at)}): {config.last_sync_info}
                  </div>
                )}
              </div>
              {canCommand ? (
                <div className="flex flex-wrap gap-2">
                  <button onClick={readConfiguration} disabled={busy} className="btn-secondary text-xs px-3 py-2">
                    Read Configuration (getparam)
                  </button>
                  <button onClick={getDeviceInfo} disabled={busy} className="btn-secondary text-xs px-3 py-2">
                    Read Live Status (getinfo)
                  </button>
                </div>
              ) : (
                <span className="text-xs text-amber-400">Read-only: your role cannot change device configuration.</span>
              )}
            </div>
            {config?.last_applied_at && (
              <div className="text-[11px] text-emerald-400">
                Last confirmed tracker configuration: {fmtDate(config.last_applied_at)}
              </div>
            )}
          </div>

          {!config ? (
            <div className="panel p-5 text-xs text-ink-500">Configuration state is unavailable for this device.</div>
          ) : (
            <>
              <div className="panel p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Current / Last-Applied Parameters</h3>
                  <span className="text-[10px] text-ink-500">Status updates when the tracker acknowledges.</span>
                </div>
                {config.parameters.length === 0 ? (
                  <div className="text-xs text-ink-500">
                    No parameters are mapped. Add them in Settings → Teltonika Parameter Map.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="table-shell">
                      <thead>
                        <tr>
                          <th>Parameter</th>
                          <th>Param ID</th>
                          <th>Desired / Applied</th>
                          <th>Status</th>
                          <th>Requested</th>
                          <th>Applied</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {config.parameters.map((p) => (
                          <tr key={`${p.param_id}-${p.feature_key}`}>
                            <td>
                              <div className="text-xs text-ink-100">{p.description || p.feature_key}</div>
                              <div className="text-[10px] text-ink-500 font-mono">
                                {p.feature_key}
                                {p.unit ? ` · ${p.unit}` : ""}
                                {p.preset_key ? ` · preset: ${p.preset_key}` : ""}
                              </div>
                            </td>
                            <td className="font-mono text-xs text-ink-300">{p.param_id}</td>
                            <td className="font-mono text-xs text-ink-100">
                              {p.desired_value ?? p.value ?? "—"}
                              <span className="text-ink-500"> / </span>
                              {p.applied_value ?? "—"}
                            </td>
                            <td>
                              <span className={`pill ${CONFIG_STATUS_STYLES[p.status] || CONFIG_STATUS_STYLES.unknown}`}>
                                {p.status}
                              </span>
                            </td>
                            <td className="text-[11px] text-ink-400 whitespace-nowrap">{fmtDate(p.requested_at)}</td>
                            <td className="text-[11px] text-ink-400 whitespace-nowrap">{fmtDate(p.applied_at)}</td>
                            <td className="whitespace-nowrap">
                              {canCommand && (
                                <button
                                  onClick={() => readParameter(p.param_id)}
                                  disabled={busy}
                                  className="text-xs text-amber-400 hover:underline"
                                >
                                  Read
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {canCommand && (
                <>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <ConfigPresetCard
                      preset={config.presets.find((p) => p.key === "reporting_interval")}
                      category="Data Acquisition & Reporting"
                      disabled={busy}
                      onApply={applyReportingInterval}
                    >
                      <label className="label">Interval (seconds)</label>
                      <input
                        type="number"
                        min={0}
                        value={configInputs["reporting_interval"] ?? ""}
                        onChange={(e) => setConfigInput("reporting_interval", e.target.value)}
                        placeholder="e.g. 30"
                        className="input text-xs w-full bg-base-900 border-base-700 text-ink-100"
                      />
                    </ConfigPresetCard>

                    <ConfigPresetCard
                      preset={config.presets.find((p) => p.key === "ignition_source")}
                      category="Ignition & Power Monitoring"
                      disabled={busy}
                      onApply={applyIgnitionSource}
                    >
                      <label className="label">Source value</label>
                      <input
                        type="number"
                        value={configInputs["ignition_source"] ?? ""}
                        onChange={(e) => setConfigInput("ignition_source", e.target.value)}
                        placeholder="FMB125 ignition source"
                        className="input text-xs w-full bg-base-900 border-base-700 text-ink-100"
                      />
                      <p className="text-[10px] text-ink-500">
                        Use the value matching the vehicle wiring (verify in the FMB125 parameter map).
                      </p>
                    </ConfigPresetCard>

                    <ConfigPresetCard
                      preset={config.presets.find((p) => p.key === "data_acquisition")}
                      category="Data Acquisition & Reporting"
                      disabled={busy}
                      onApply={applyDataAcquisition}
                    >
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="label">Ignition ON (s)</label>
                          <input
                            type="number"
                            min={0}
                            value={configInputs["data_acquisition_ignition_on"] ?? ""}
                            onChange={(e) => setConfigInput("data_acquisition_ignition_on", e.target.value)}
                            placeholder="e.g. 10"
                            className="input text-xs w-full bg-base-900 border-base-700 text-ink-100"
                          />
                        </div>
                        <div>
                          <label className="label">Ignition OFF (s)</label>
                          <input
                            type="number"
                            min={0}
                            value={configInputs["data_acquisition_ignition_off"] ?? ""}
                            onChange={(e) => setConfigInput("data_acquisition_ignition_off", e.target.value)}
                            placeholder="e.g. 60"
                            className="input text-xs w-full bg-base-900 border-base-700 text-ink-100"
                          />
                        </div>
                      </div>
                    </ConfigPresetCard>

                    <ConfigPresetCard
                      preset={config.presets.find((p) => p.key === "digital_output_control")}
                      category="Digital I/O & Immobilizer Control"
                      disabled={busy}
                      onApply={applyDigitalOutput}
                    >
                      <label className="label">DOUT1 state</label>
                      <select
                        value={configInputs["digital_output_control"] ?? "0"}
                        onChange={(e) => setConfigInput("digital_output_control", e.target.value)}
                        className="input text-xs w-full bg-base-900 border-base-700 text-ink-100"
                      >
                        <option value="0">0 — OFF</option>
                        <option value="1">1 — ON</option>
                      </select>
                    </ConfigPresetCard>
                  </div>

                  <div className="panel p-5 space-y-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">
                          4) Advanced Parameter Editor
                        </h3>
                        <span className="text-[10px] uppercase tracking-wider text-amber-400/80 font-semibold">
                          Server/GPRS/APN writes are flagged
                        </span>
                      </div>
                      <p className="text-[11px] text-ink-500 mt-1">
                        Write any Teltonika parameter by numeric ID. Use this for firmware-specific settings not
                        covered by a preset.
                      </p>
                      {serverParamWarning && (
                        <div className="mt-2 p-2 rounded border border-amber-400/40 bg-amber-400/10 text-[11px] text-amber-300">
                          Warning: parameter IDs 2000–2199 are server/GPRS/APN settings. An incorrect value can
                          disconnect the tracker from MeshSat and require physical access to recover.
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                      <div className="sm:w-40">
                        <label className="label">Param ID</label>
                        <input
                          type="number"
                          min={1}
                          value={rawParam.param_id}
                          onChange={(e) => setRawParam((prev) => ({ ...prev, param_id: e.target.value }))}
                          placeholder="e.g. 1580"
                          className="input text-xs w-full bg-base-900 border-base-700 text-ink-100"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="label">Value</label>
                        <input
                          type="text"
                          value={rawParam.value}
                          onChange={(e) => setRawParam((prev) => ({ ...prev, value: e.target.value }))}
                          placeholder="Value to set"
                          className="input text-xs w-full bg-base-900 border-base-700 text-ink-100"
                        />
                      </div>
                      <button
                        onClick={applyRawParameter}
                        disabled={busy}
                        className="btn-primary text-xs px-4 py-2 whitespace-nowrap"
                      >
                        Set Parameter
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Camera / Media tab (only when the device has a camera) */}
      {activeTab === "camera" && (
        <div className="panel p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Camera / Media</h2>
            {canCommand && (
              <button onClick={() => requestCamera(1)} disabled={busy} className="btn-secondary text-xs px-3 py-2">
                Request Snapshot
              </button>
            )}
          </div>
          {media.length === 0 ? (
            <div className="text-xs text-ink-500">No camera or sensor media recorded for this device.</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {media.map((m) => (
                <a
                  key={m.id}
                  href={m.storage_url}
                  target="_blank"
                  rel="noreferrer"
                  className="p-3 rounded-lg bg-base-950 border border-base-800 space-y-2 hover:border-amber-400/50"
                >
                  <div className="text-[10px] uppercase tracking-wide text-ink-500">{m.media_type} · ch {m.camera_channel ?? "—"}</div>
                  <div className="text-xs text-ink-100 break-words">{m.trigger_type}</div>
                  <div className="text-[10px] text-ink-500">{fmtDate(m.captured_at)}</div>
                  <div className="text-[10px] text-amber-400 truncate">{m.storage_url}</div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CAN / BLE tab (only when the device supports CAN J1939 or BLE sensors) */}
      {activeTab === "canble" && (
        <div className="panel p-5 space-y-3">
          <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">
            {capabilities?.has_can_j1939 ? "CAN / J1939" : "BLE Sensors"}
          </h2>
          <p className="text-xs text-ink-500">
            This device reports{" "}
            {[capabilities?.has_can_j1939 ? "CAN J1939" : null, capabilities?.has_ble_sensors ? "BLE sensors" : null]
              .filter(Boolean)
              .join(" and ")}
            . Extended CAN bus and BLE sensor telemetry will appear here once enabled for this device.
          </p>
        </div>
      )}

      {/* Command history — applies to every command type */}
      <div className="panel overflow-hidden">
        <div className="px-5 py-3 border-b border-base-700 flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink-100">Command History &amp; Queue</span>
          <span className="text-[10px] text-ink-500">
            {config?.queued_count ? `${config.queued_count} queued for check-in` : "No queued commands"}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Command</th>
                <th>Status</th>
                <th>Response</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {commands.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-ink-500 py-8">No commands issued for this device.</td>
                </tr>
              ) : (
                commands.map((c) => (
                  <tr key={c.id}>
                    <td className="text-xs text-ink-400 whitespace-nowrap">{fmtDate(c.created_at)}</td>
                    <td className="text-xs capitalize text-ink-200">{c.command_type}</td>
                    <td className="text-[11px] font-mono text-amber-400 max-w-xs truncate" title={c.payload_json}>
                      {c.raw_command || serializedCommand(c.payload_json)}
                    </td>
                    <td>
                      <span className={`pill ${STATUS_STYLES[c.status] || "bg-base-600 text-ink-300"} capitalize`}>{c.status}</span>
                    </td>
                    <td className="text-xs text-ink-400 max-w-xs truncate">{c.response_payload || c.response_text || "—"}</td>
                    <td>
                      {c.status === "queued" && canCommand && (
                        <button onClick={() => cancel(c.id)} disabled={busy} className="text-xs text-signal-red hover:underline">
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Immobilizer confirmation — required before any ignition cut/restore */}
      {confirmDigout !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="panel w-full max-w-md p-5 space-y-4">
            <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">
              {confirmDigout === 1 ? "Confirm Ignition Cut (Immobilize)" : "Confirm Ignition Restore"}
            </h3>
            <div className="text-xs space-y-3 text-ink-200">
              <div className="space-y-1">
                <div>
                  Vehicle:{" "}
                  <span className="font-semibold text-ink-100">
                    {device.vehicle_number} ({device.registration_number})
                  </span>
                </div>
                <div>
                  IMEI: <span className="font-mono">{device.imei}</span>
                </div>
                <div>
                  Current state: ignition{" "}
                  <span className="font-semibold">{live || ignitionFeature ? (ignitionOn ? "ON" : "OFF") : "—"}</span>
                  {" · "}immobilizer{" "}
                  <span className="font-semibold">{doutFeature ? (doutEngaged ? "CUT" : "RELEASED") : "—"}</span>
                  {" · "}last speed <span className="font-semibold">{lastSpeed != null ? `${lastSpeed} km/h` : "—"}</span>
                </div>
                <div>
                  Command to send: <span className="font-mono text-amber-400">setdigout {confirmDigout} 1</span>
                </div>
              </div>
              {confirmDigout === 1 ? (
                <div className="p-3 rounded bg-signal-red/10 text-signal-red">
                  Warning: cutting the ignition immobilizes this vehicle. It will not start until the ignition is
                  restored. Only proceed if the vehicle is stationary and it is safe and authorised to do so. Cutting
                  the ignition on a moving vehicle (over {IGNITION_CUT_SPEED_LIMIT_KMH} km/h) is blocked by the API.
                </div>
              ) : (
                <div className="p-3 rounded bg-amber-400/10 text-amber-400">
                  This restores the ignition and allows the vehicle to start again.
                </div>
              )}
              {confirmDigout === 1 && (
                <div className="space-y-1">
                  <label className="text-[11px] text-ink-400">Reason (required — recorded in the audit log)</label>
                  <input
                    type="text"
                    value={confirmReason}
                    onChange={(e) => setConfirmReason(e.target.value)}
                    placeholder="e.g. authorised immobilisation after theft report"
                    className="input w-full text-xs bg-base-900 border-base-700 text-ink-100"
                  />
                </div>
              )}
              {confirmDigout === 1 && isAdmin && moving && (
                <label className="flex items-start gap-2 cursor-pointer p-2 rounded bg-signal-red/10">
                  <input
                    type="checkbox"
                    checked={confirmForce}
                    onChange={(e) => setConfirmForce(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-signal-red">
                    Force the ignition cut despite the vehicle moving ({lastSpeed} km/h). This override is audited as
                    IGNITION_CUT_FORCED.
                  </span>
                </label>
              )}
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmChecked}
                  onChange={(e) => setConfirmChecked(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  {confirmDigout === 1
                    ? "I understand this will immobilize the vehicle and confirm I am authorised to issue this command."
                    : "I confirm I want to restore this vehicle's ignition."}
                </span>
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDigout(null)} className="btn-secondary text-xs px-4 py-2">
                Cancel
              </button>
              <button
                onClick={confirmDigoutAction}
                disabled={!confirmChecked || busy || (confirmDigout === 1 && !confirmReason.trim())}
                className={
                  confirmDigout === 1
                    ? "bg-signal-red hover:bg-signal-red/80 text-white font-semibold px-4 py-2 rounded-md transition-colors text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                    : "btn-primary text-xs px-4 py-2"
                }
              >
                Issue Command
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
