import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  telemetryApi,
  DeviceFeatures,
  DeviceCommand,
  IoFeature,
  ParamMapRow,
} from "../api/telemetry";
import { apiGet } from "../api/client";
import { useAuth } from "../context/AuthContext";

/** Roles allowed to dispatch remote device commands (mirrors the API guard). */
const COMMAND_ROLES = new Set(["admin", "fleet_manager"]);

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-amber-400/15 text-amber-400",
  sent: "bg-signal-green/15 text-signal-green",
  acked: "bg-emerald-500/15 text-emerald-400",
  acknowledged: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-signal-red/15 text-signal-red",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-signal-red/15 text-signal-red",
  warning: "bg-amber-400/15 text-amber-400",
  info: "bg-base-600 text-ink-200",
};

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
      case "setdigout":
        return c.timeout !== undefined && c.timeout !== null ? `setdigout ${c.dout} ${c.timeout}` : `setdigout ${c.dout}`;
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

export default function DeviceTelemetry() {
  const { imei } = useParams<{ imei: string }>();
  const { user } = useAuth();
  const canCommand = !!user && COMMAND_ROLES.has(user.role);

  const [device, setDevice] = useState<DeviceFeatures | null>(null);
  const [commands, setCommands] = useState<DeviceCommand[]>([]);
  const [params, setParams] = useState<ParamMapRow[]>([]);
  const [paramInputs, setParamInputs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  // Pending immobilizer action awaiting explicit confirmation.
  const [confirmDigout, setConfirmDigout] = useState<0 | 1 | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [confirmReason, setConfirmReason] = useState("");

  const load = useCallback(async () => {
    if (!imei) return;
    try {
      const [featuresRes, commandsRes] = await Promise.all([
        telemetryApi.features(imei),
        telemetryApi.commands.list(imei),
      ]);
      setDevice(featuresRes.data);
      setCommands(commandsRes.data);
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
    if (!canCommand) return;
    apiGet<{ data: ParamMapRow[] }>("/settings/param-map")
      .then((res) => {
        setParams(res.data);
        const initial: Record<string, string> = {};
        for (const p of res.data) initial[p.feature_key] = "";
        setParamInputs(initial);
      })
      .catch(() => setParams([]));
  }, [canCommand]);

  const fuelEvents = useMemo(
    () => (device?.events ?? []).filter((e) => e.type === "refuel" || e.type === "fuel_drain"),
    [device]
  );

  async function sendSetparam(p: ParamMapRow) {
    if (!imei) return;
    const raw = paramInputs[p.feature_key];
    if (raw === "" || raw === undefined) {
      setError(`Enter a value for ${p.description || p.feature_key} first.`);
      return;
    }
    const numeric = Number(raw);
    const value = Number.isNaN(numeric) ? raw : numeric;
    await issue({ imei, type: "setparam", params: { feature_key: p.feature_key, value } });
  }

  async function sendDigout(dout: 0 | 1, reason?: string) {
    if (!imei) return;
    await issue({ imei, type: "setdigout", params: { dout }, ...(reason ? { reason } : {}) });
  }

  /** Opens the confirmation modal for an immobilizer action (no dispatch yet). */
  function requestDigout(dout: 0 | 1) {
    setConfirmChecked(false);
    setConfirmReason("");
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
    setConfirmDigout(null);
    await sendDigout(dout, reason || undefined);
  }

  /** Read-only status command (getinfo / getgps / getver). */
  async function sendDiagnostic(command: "getinfo" | "getgps" | "getver") {
    if (!imei) return;
    await issue({ imei, type: "diagnostic", params: { command } });
  }

  async function issue(body: { imei: string; type: "setparam" | "setdigout" | "diagnostic" | "raw"; params?: Record<string, string | number | boolean> }) {
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

  // Current immobilizer-relevant state, decoded from the latest IO payload:
  // IO 239 = ignition state, IO 179 = DOUT1 / immobilizer output.
  const ignitionFeature = device.features.find((f) => f.io_id === 239);
  const doutFeature =
    device.features.find((f) => f.io_id === 179 && f.feature_key === "immobilizer") ??
    device.features.find((f) => f.io_id === 179);
  const ignitionOn = live?.ignition === 1 || ignitionFeature?.value === 1;
  const doutEngaged = doutFeature?.value === 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-base-700 pb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-ink-100">{device.vehicle_number || "Device"}</h1>
            <span className="text-sm font-mono px-2 py-0.5 rounded bg-base-800 text-ink-300">{device.registration_number}</span>
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
        <Link to="/telemetry" className="btn-secondary text-xs px-3 py-2">&larr; Back to live status</Link>
      </div>

      {error && <div className="p-4 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}
      {notice && <div className="p-4 rounded-lg bg-amber-400/10 text-amber-400 text-sm">{notice}</div>}

      {/* Live status */}
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
        </div>
      </div>

      {/* Feature grid */}
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

      {/* Fuel report */}
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

      {/* Recent events */}
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

      {/* Command & control (staff with command roles only) */}
      {canCommand && (
        <>
          <div className="panel p-5 space-y-4">
            <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Device Configuration &amp; Control</h2>
            <p className="text-xs text-ink-500">
              Commands are queued on the relay and delivered over the tracker&apos;s next TCP sync — status shows
              &ldquo;Queued / Pending Next Tracker Sync&rdquo; until acknowledged.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {params.map((p) => (
                <div key={p.id} className="p-3 rounded-lg bg-base-950 border border-base-800 space-y-2">
                  <div>
                    <div className="text-xs font-semibold text-ink-100">{p.description || p.feature_key}</div>
                    <div className="text-[10px] text-ink-500 font-mono">param {p.param_id} · {p.feature_key}</div>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={paramInputs[p.feature_key] ?? ""}
                      onChange={(e) => setParamInputs((prev) => ({ ...prev, [p.feature_key]: e.target.value }))}
                      placeholder="New value"
                      className="input text-xs flex-1 bg-base-900 border-base-700 text-ink-100"
                    />
                    <button
                      onClick={() => sendSetparam(p)}
                      disabled={busy}
                      className="btn-primary text-xs px-3 py-2 whitespace-nowrap"
                    >
                      Set
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-base-800 pt-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="text-xs font-semibold text-ink-100">Remote Ignition Shutdown / Restore</div>
                <div className="flex items-center gap-4 text-[11px]">
                  <span className="text-ink-500">
                    Ignition:{" "}
                    <span className={ignitionOn ? "text-signal-green font-semibold" : "text-ink-300 font-semibold"}>
                      {live || ignitionFeature ? (ignitionOn ? "ON" : "OFF") : "—"}
                    </span>
                  </span>
                  <span className="text-ink-500">
                    Immobilizer (DOUT1):{" "}
                    <span className={doutEngaged ? "text-signal-red font-semibold" : "text-ink-300 font-semibold"}>
                      {doutFeature ? (doutEngaged ? "CUT / ENGAGED" : "RELEASED") : "—"}
                    </span>
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-ink-500">
                Cutting the ignition immobilizes the vehicle via DOUT1. Both actions require explicit confirmation
                before the command is queued.
              </p>
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
            </div>

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
              </div>
            </div>
          </div>

          <div className="panel overflow-hidden">
            <div className="px-5 py-3 border-b border-base-700 text-sm font-semibold text-ink-100">Command History</div>
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
                          {serializedCommand(c.payload_json)}
                        </td>
                        <td>
                          <span className={`pill ${STATUS_STYLES[c.status] || "bg-base-600 text-ink-300"} capitalize`}>{c.status}</span>
                        </td>
                        <td className="text-xs text-ink-400 max-w-xs truncate">{c.response_text || "—"}</td>
                        <td>
                          {c.status === "queued" && (
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
        </>
      )}

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
                  Command to send: <span className="font-mono text-amber-400">setdigout {confirmDigout}</span>
                </div>
              </div>
              {confirmDigout === 1 ? (
                <div className="p-3 rounded bg-signal-red/10 text-signal-red">
                  Warning: cutting the ignition immobilizes this vehicle. It will not start until the ignition is
                  restored. Only proceed if the vehicle is stationary and it is safe and authorised to do so. Cutting
                  the ignition on a moving vehicle (over 10 km/h) is blocked by the API.
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
