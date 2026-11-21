import { useEffect, useState } from "react";
import { telemetryApi, TelemetrySummary } from "../api/telemetry";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-signal-red/15 text-signal-red",
  warning: "bg-amber-400/15 text-amber-400",
  info: "bg-base-600 text-ink-200",
};

export default function TelemetryReport() {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [from, setFrom] = useState(isoDate(thirtyDaysAgo));
  const [to, setTo] = useState(isoDate(today));
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await telemetryApi.summary(from, to);
      setSummary(res.data);
    } catch (err: any) {
      setError(err.message || "Failed to load telemetry report");
    } finally {
      setLoading(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const blob = await telemetryApi.exportCsv(from, to);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `telemetry_${from}_${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message || "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const totals = summary?.totals;

  return (
    <div className="space-y-6">
      {/* Header + controls (hidden when printing) */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 no-print">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Fuel Consumption &amp; Alert Report</h1>
          <p className="text-sm text-ink-400">Date-range fuel consumption, refuel/drain events and fleet exception log</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input text-xs w-40" />
          </div>
          <div>
            <label className="label">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input text-xs w-40" />
          </div>
          <button onClick={load} className="btn-secondary text-xs px-4 py-2">Run report</button>
          <button onClick={exportCsv} disabled={exporting} className="btn-primary text-xs px-4 py-2">
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <button onClick={() => window.print()} className="btn-secondary text-xs px-4 py-2">Print</button>
        </div>
      </div>

      {/* Print-only heading */}
      <div className="hidden print:block">
        <h1 className="text-xl font-bold text-black">Fleet Telemetry Report</h1>
        <p className="text-sm text-black">
          Period {from} to {to}
          {summary?.clients_scoped && summary.clients_scoped !== "all" ? " · client-scoped" : ""}
        </p>
      </div>

      {error && <div className="p-4 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}

      {loading ? (
        <div className="p-8 text-center text-ink-400">Loading report…</div>
      ) : !summary ? null : (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="panel p-5">
              <div className="text-xs uppercase tracking-wide text-ink-500 mb-2">Distance</div>
              <div className="font-data text-2xl font-semibold text-ink-100">{totals?.distance_km.toLocaleString() ?? 0} km</div>
            </div>
            <div className="panel p-5">
              <div className="text-xs uppercase tracking-wide text-ink-500 mb-2">Fuel refuelled</div>
              <div className="font-data text-2xl font-semibold text-signal-green">{totals?.fuel_refueled_liters.toLocaleString() ?? 0} L</div>
            </div>
            <div className="panel p-5">
              <div className="text-xs uppercase tracking-wide text-ink-500 mb-2">Fuel consumed</div>
              <div className="font-data text-2xl font-semibold text-amber-400">{totals?.fuel_consumed_liters.toLocaleString() ?? 0} L</div>
            </div>
            <div className="panel p-5">
              <div className="text-xs uppercase tracking-wide text-ink-500 mb-2">Events</div>
              <div className="font-data text-2xl font-semibold text-ink-100">{totals?.event_count ?? 0}</div>
            </div>
          </div>

          {/* Per-vehicle consumption */}
          <div className="panel overflow-hidden">
            <div className="px-5 py-3 border-b border-base-700 text-sm font-semibold text-ink-100">Per-vehicle consumption</div>
            <div className="overflow-x-auto">
              <table className="table-shell">
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th>Registration</th>
                    <th>Distance</th>
                    <th>Refuelled</th>
                    <th>Consumed</th>
                    <th>L/100km</th>
                    <th>Fixes</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.vehicles.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center text-ink-500 py-8">No telemetry in this period.</td>
                    </tr>
                  ) : (
                    summary.vehicles.map((v) => (
                      <tr key={v.vehicle_id}>
                        <td className="font-medium">{v.vehicle_number}</td>
                        <td className="font-mono text-xs">{v.registration_number}</td>
                        <td className="font-data">{v.distance_km.toLocaleString()} km</td>
                        <td className="font-data text-signal-green">{v.fuel_refueled_liters} L</td>
                        <td className="font-data text-amber-400">{v.fuel_consumed_liters} L</td>
                        <td className="font-data">{v.fuel_efficiency_l_per_100km ?? "—"}</td>
                        <td className="font-data text-ink-400">{v.fix_count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Alert / event log */}
          <div className="panel overflow-hidden">
            <div className="px-5 py-3 border-b border-base-700 text-sm font-semibold text-ink-100">
              Alert &amp; event log ({summary.events.length})
            </div>
            <div className="overflow-x-auto">
              <table className="table-shell">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Severity</th>
                    <th>Rule</th>
                    <th>Category</th>
                    <th>Vehicle</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.events.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center text-ink-500 py-8">No events logged in this period.</td>
                    </tr>
                  ) : (
                    summary.events.map((e) => (
                      <tr key={e.id}>
                        <td className="text-xs text-ink-400 whitespace-nowrap">
                          {new Date(e.created_at.replace(" ", "T") + "Z").toLocaleString()}
                        </td>
                        <td>
                          <span className={`pill ${SEVERITY_STYLES[e.severity] || "bg-base-600 text-ink-300"}`}>{e.severity}</span>
                        </td>
                        <td className="font-mono text-xs text-amber-400">{e.rule_code}</td>
                        <td className="capitalize text-xs text-ink-300">{e.category}</td>
                        <td className="text-xs">{e.vehicle_number || "—"}</td>
                        <td className="text-xs text-ink-200">{e.description}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
