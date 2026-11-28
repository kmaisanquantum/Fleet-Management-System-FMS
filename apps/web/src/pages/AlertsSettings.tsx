import { useEffect, useState } from "react";
import {
  alertSettingsApi,
  type AlertSettings,
  type EmailDelivery,
  type FleetAlert,
} from "../api/reports";

function formatPgt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-AU", { timeZone: "Pacific/Port_Moresby", hour12: false });
}

const STATUS_STYLE: Record<string, string> = {
  sent: "bg-signal-green/15 text-signal-green",
  failed: "bg-signal-red/15 text-signal-red",
  skipped: "bg-amber-400/15 text-amber-400",
};

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-signal-red/15 text-signal-red",
  warning: "bg-amber-400/15 text-amber-400",
  info: "bg-base-600 text-ink-200",
};

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex items-start gap-3 p-3 rounded-lg border border-base-700 bg-base-800/50 cursor-pointer">
      <input
        type="checkbox"
        className="mt-0.5 accent-amber-400"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm text-ink-100">{label}</span>
        <span className="block text-[11px] text-ink-500 mt-0.5 leading-relaxed">{description}</span>
      </span>
    </label>
  );
}

export default function AlertsSettings() {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [alerts, setAlerts] = useState<FleetAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([alertSettingsApi.get(), alertSettingsApi.deliveries(100), alertSettingsApi.alerts(100)])
      .then(([settingsRes, deliveriesRes, alertsRes]) => {
        setSettings(settingsRes.data);
        setDeliveries(deliveriesRes.data);
        setAlerts(alertsRes.data);
      })
      .catch((err: Error) => setError(err.message || "Failed to load alert settings"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function patchRecipient<K extends keyof AlertSettings["recipients"]>(key: K, value: AlertSettings["recipients"][K]) {
    setSettings((current) => (current ? { ...current, recipients: { ...current.recipients, [key]: value } } : current));
  }

  function patchThreshold<K extends keyof AlertSettings["thresholds"]>(key: K, value: AlertSettings["thresholds"][K]) {
    setSettings((current) => (current ? { ...current, thresholds: { ...current.thresholds, [key]: value } } : current));
  }

  function patchToggle<K extends keyof AlertSettings["toggles"]>(key: K, value: AlertSettings["toggles"][K]) {
    setSettings((current) => (current ? { ...current, toggles: { ...current.toggles, [key]: value } } : current));
  }

  function patchSchedule<K extends keyof AlertSettings["schedule"]>(key: K, value: AlertSettings["schedule"][K]) {
    setSettings((current) => (current ? { ...current, schedule: { ...current.schedule, [key]: value } } : current));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await alertSettingsApi.update({
        recipients: settings.recipients,
        thresholds: settings.thresholds,
        toggles: settings.toggles,
        schedule: settings.schedule,
      });
      setSettings(res.data);
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function testEmail() {
    setTesting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await alertSettingsApi.testEmail();
      setMessage(res.message);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test email failed");
    } finally {
      setTesting(false);
    }
  }

  async function acknowledge(id: string) {
    try {
      await alertSettingsApi.acknowledge(id);
      setAlerts((current) => current.map((alert) => (alert.id === id ? { ...alert, acknowledged: 1 } : alert)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to acknowledge alert");
    }
  }

  if (loading && !settings) return <div className="p-10 text-center text-ink-400">Loading alert settings…</div>;
  if (!settings) return <div className="p-10 text-center text-signal-red">{error ?? "Alert settings unavailable"}</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Alerts &amp; Email Rules</h1>
          <p className="text-sm text-ink-400 mt-1">
            Real-time telemetry alerts, SMTP delivery and scheduled report forwarding to {settings.recipients.alert}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => load()} className="btn-secondary text-xs px-4 py-2">Refresh</button>
          <button onClick={() => void testEmail()} disabled={testing} className="btn-secondary text-xs px-4 py-2">
            {testing ? "Sending…" : "Send test email"}
          </button>
          <button onClick={() => void save()} disabled={saving} className="btn-primary text-xs px-4 py-2">
            {saving ? "Saving…" : "Save rules"}
          </button>
        </div>
      </div>

      {error && <div className="p-3 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}
      {message && <div className="p-3 rounded-lg bg-signal-green/10 text-signal-green text-sm">{message}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className={`panel p-5 xl:col-span-1 border ${settings.smtp.configured ? "border-signal-green/30" : "border-amber-400/40"}`}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-100">SMTP delivery</div>
            <span className={`pill ${settings.smtp.configured ? "bg-signal-green/15 text-signal-green" : "bg-amber-400/15 text-amber-400"}`}>
              {settings.smtp.configured ? "Configured" : "Not configured"}
            </span>
          </div>
          <div className="mt-3 space-y-1 text-xs text-ink-400">
            <div>Host: <span className="font-mono text-ink-200">{settings.smtp.host ?? "—"}</span></div>
            <div>Port: <span className="font-mono text-ink-200">{settings.smtp.port}</span> · {settings.smtp.secure ? "TLS" : "STARTTLS"}</div>
            <div>From: <span className="font-mono text-ink-200">{settings.smtp.from}</span></div>
            <div>Auth: {settings.smtp.authConfigured ? "username / password" : "not configured"}</div>
          </div>
          {!settings.smtp.configured && (
            <p className="mt-3 text-[11px] text-amber-400 leading-relaxed">
              Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in the API environment, then restart the API.
              Alerts are still recorded; delivery is marked skipped until SMTP is configured.
            </p>
          )}
        </div>

        <div className="panel p-5 xl:col-span-2">
          <div className="text-sm font-semibold text-ink-100">Recipients</div>
          <p className="text-[11px] text-ink-500 mt-1">All alerts and reports are routed to fleet@dspng.tech by default. Add optional CC recipients below.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <div>
              <label className="label">Alert recipient</label>
              <input className="input text-xs" value={settings.recipients.alert} onChange={(event) => patchRecipient("alert", event.target.value)} />
            </div>
            <div>
              <label className="label">Alert CC / extra recipients</label>
              <input className="input text-xs" placeholder="ops@dspng.tech, manager@dspng.tech" value={settings.recipients.alertCc} onChange={(event) => patchRecipient("alertCc", event.target.value)} />
            </div>
            <div>
              <label className="label">Report recipient</label>
              <input className="input text-xs" value={settings.recipients.report} onChange={(event) => patchRecipient("report", event.target.value)} />
            </div>
            <div>
              <label className="label">Report CC / extra recipients</label>
              <input className="input text-xs" placeholder="fleet.manager@dspng.tech" value={settings.recipients.reportCc} onChange={(event) => patchRecipient("reportCc", event.target.value)} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="panel p-5">
          <div className="text-sm font-semibold text-ink-100">Real-time alert rules</div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="label">Overspeed threshold (km/h)</label>
              <input type="number" className="input text-xs" value={settings.thresholds.overspeedKmh} onChange={(event) => patchThreshold("overspeedKmh", Number(event.target.value))} />
            </div>
            <div>
              <label className="label">Low voltage (V)</label>
              <input type="number" step="0.1" className="input text-xs" value={settings.thresholds.lowVoltageV} onChange={(event) => patchThreshold("lowVoltageV", Number(event.target.value))} />
            </div>
            <div>
              <label className="label">Duplicate cooldown (seconds)</label>
              <input type="number" className="input text-xs" value={settings.thresholds.cooldownSeconds} onChange={(event) => patchThreshold("cooldownSeconds", Number(event.target.value))} />
            </div>
            <div>
              <label className="label">Offline after (minutes)</label>
              <input type="number" className="input text-xs" value={settings.thresholds.offlineMinutes} onChange={(event) => patchThreshold("offlineMinutes", Number(event.target.value))} />
            </div>
            <div>
              <label className="label">Offline repeat (minutes)</label>
              <input type="number" className="input text-xs" value={settings.thresholds.offlineCooldownMinutes} onChange={(event) => patchThreshold("offlineCooldownMinutes", Number(event.target.value))} />
            </div>
            <div>
              <label className="label">Idle exception (minutes)</label>
              <input type="number" className="input text-xs" value={settings.thresholds.idleMinutes} onChange={(event) => patchThreshold("idleMinutes", Number(event.target.value))} />
            </div>
            <div>
              <label className="label">Fuel card GPS distance (km)</label>
              <input type="number" step="0.1" className="input text-xs" value={settings.thresholds.fuelCardDistanceKm} onChange={(event) => patchThreshold("fuelCardDistanceKm", Number(event.target.value))} />
            </div>
            <div>
              <label className="label">Camera offline after (minutes)</label>
              <input type="number" className="input text-xs" value={settings.thresholds.cameraOfflineMinutes} onChange={(event) => patchThreshold("cameraOfflineMinutes", Number(event.target.value))} />
            </div>
            <div>
              <label className="label">Camera offline repeat (minutes)</label>
              <input type="number" className="input text-xs" value={settings.thresholds.cameraOfflineCooldownMinutes} onChange={(event) => patchThreshold("cameraOfflineCooldownMinutes", Number(event.target.value))} />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4">
            <Toggle checked={settings.toggles.emailAlerts} onChange={(value) => patchToggle("emailAlerts", value)} label="Email alerts" description="Send an email for every newly triggered alert." />
            <Toggle checked={settings.toggles.overspeed} onChange={(value) => patchToggle("overspeed", value)} label="Overspeeding" description="Speed above the configured threshold." />
            <Toggle checked={settings.toggles.ignition} onChange={(value) => patchToggle("ignition", value)} label="Ignition ON/OFF" description="Notify on ignition transitions." />
            <Toggle checked={settings.toggles.offline} onChange={(value) => patchToggle("offline", value)} label="Device offline" description="No ingest within the offline window." />
            <Toggle checked={settings.toggles.power} onChange={(value) => patchToggle("power", value)} label="Power / low voltage" description="Power cut or external voltage drop." />
            <Toggle checked={settings.toggles.geofence} onChange={(value) => patchToggle("geofence", value)} label="Geofence entry/exit" description="Zone entry and exit transitions." />
            <Toggle checked={settings.toggles.security} onChange={(value) => patchToggle("security", value)} label="Jamming / SOS / DIN" description="Jamming, immobilizer, SOS and digital-input triggers." />
            <Toggle checked={settings.toggles.fuelCard} onChange={(value) => patchToggle("fuelCard", value)} label="Fuel card anomalies" description="Card status, tank capacity, limits and GPS mismatch on swipes." />
            <Toggle checked={settings.toggles.cameraOffline} onChange={(value) => patchToggle("cameraOffline", value)} label="Camera offline / unreachable" description="Email when a camera feed has not been reachable within the camera offline window." />
          </div>
        </div>

        <div className="panel p-5">
          <div className="text-sm font-semibold text-ink-100">Scheduled report forwarding</div>
          <p className="text-[11px] text-ink-500 mt-1">Six CSV reports are attached to each scheduled fleet summary. Times are Port Moresby (UTC+10).</p>
          <div className="space-y-3 mt-4">
            {[
              { key: "daily" as const, label: "Daily summary" },
              { key: "weekly" as const, label: "Weekly summary (Monday)" },
              { key: "monthly" as const, label: "Monthly summary (1st)" },
            ].map((item) => {
              const enabledKey = `${item.key}Enabled` as keyof AlertSettings["schedule"];
              const timeKey = `${item.key}Time` as keyof AlertSettings["schedule"];
              return (
                <div key={item.key} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-base-700 bg-base-800/50">
                  <label className="flex items-center gap-2 text-sm text-ink-100">
                    <input
                      type="checkbox"
                      className="accent-amber-400"
                      checked={Boolean(settings.schedule[enabledKey])}
                      onChange={(event) => patchSchedule(enabledKey, event.target.checked as never)}
                    />
                    {item.label}
                  </label>
                  <input
                    type="time"
                    className="input text-xs w-28"
                    value={String(settings.schedule[timeKey])}
                    onChange={(event) => patchSchedule(timeKey, event.target.value as never)}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-4 text-[11px] text-ink-500">
            Delivery log below records every scheduled, alert, report and test message, including SMTP errors.
          </div>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="px-5 py-3 border-b border-base-700 flex items-center justify-between">
          <div className="text-sm font-semibold text-ink-100">Recent email deliveries</div>
          <div className="text-[11px] text-ink-500">{deliveries.length} records</div>
        </div>
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr><td colSpan={6} className="text-center text-ink-500 py-8">No email attempts recorded yet.</td></tr>
              ) : (
                deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td className="text-xs text-ink-400 whitespace-nowrap">{formatPgt(delivery.created_at)}</td>
                    <td className="text-xs capitalize">{delivery.kind.replace(/_/g, " ")}</td>
                    <td className="text-xs font-mono">{delivery.recipient}{delivery.cc ? ` · cc ${delivery.cc}` : ""}</td>
                    <td className="text-xs text-ink-200 max-w-md truncate">{delivery.subject}</td>
                    <td><span className={`pill ${STATUS_STYLE[delivery.status] ?? "bg-base-600 text-ink-200"}`}>{delivery.status}</span></td>
                    <td className="text-xs text-signal-red max-w-sm truncate">{delivery.error ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="px-5 py-3 border-b border-base-700 flex items-center justify-between">
          <div className="text-sm font-semibold text-ink-100">Recent real-time alerts</div>
          <div className="text-[11px] text-ink-500">{alerts.length} records</div>
        </div>
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead>
              <tr>
                <th>When</th>
                <th>Vehicle</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Message</th>
                <th>Email</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 ? (
                <tr><td colSpan={7} className="text-center text-ink-500 py-8">No real-time alerts recorded yet.</td></tr>
              ) : (
                alerts.map((alert) => (
                  <tr key={alert.id}>
                    <td className="text-xs text-ink-400 whitespace-nowrap">{formatPgt(alert.created_at)}</td>
                    <td className="text-xs">{alert.vehicle_number ?? alert.imei}</td>
                    <td className="text-xs capitalize">{alert.alert_type.replace(/_/g, " ")}</td>
                    <td><span className={`pill ${SEVERITY_STYLE[alert.severity] ?? "bg-base-600 text-ink-200"}`}>{alert.severity}</span></td>
                    <td className="text-xs text-ink-200 max-w-lg">{alert.message}</td>
                    <td className="text-[11px]">
                      {alert.email_sent ? <span className="text-signal-green">sent</span> : <span className="text-amber-400">{alert.email_error ?? "pending"}</span>}
                    </td>
                    <td>
                      {!alert.acknowledged && (
                        <button onClick={() => void acknowledge(alert.id)} className="btn-secondary text-[10px] px-2 py-1">Ack</button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
