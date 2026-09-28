import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";

interface OverviewData {
  totalVehicles: number;
  statusCounts: {
    moving: number;
    stationary: number;
    idle: number;
    offline: number;
    under_maintenance: number;
    unassigned: number;
  };
  distanceTodayKm: number;
  fuelConsumedTodayLitres: number;
  fuelCostTodayAmount: number;
  utilisationPct: number;
  exceptions: {
    totalOpen: number;
    critical: number;
    warning: number;
    info: number;
    byCategory: { category: string; count: number }[];
    recent: any[];
  };
}

export default function FleetDashboard() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadOverview();
  }, []);

  async function loadOverview() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ data: OverviewData }>("/fleet/overview");
      setData(res.data);
    } catch (err: any) {
      setError(err.message || "Failed to load fleet overview");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <div className="p-8 text-ink-400">Loading Fleet Intelligence Overview…</div>;
  }

  if (error || !data) {
    return (
      <div className="p-8 text-red-400">
        Error loading fleet overview: {error || "No data available"}
      </div>
    );
  }

  const { totalVehicles, statusCounts, distanceTodayKm, fuelConsumedTodayLitres, fuelCostTodayAmount, utilisationPct, exceptions } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Fleet Overview & Intelligence</h1>
          <p className="text-sm text-ink-400">Real-time status, GPS tracking, and automated fuel reconciliation metrics</p>
        </div>
        <div className="flex gap-3">
          <Link to="/live-map" className="btn-amber text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-2">
            <span>🗺️ Live Map View</span>
          </Link>
          <Link to="/exceptions" className="btn-secondary text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-2">
            <span>🚨 Exception Centre ({exceptions.totalOpen})</span>
          </Link>
        </div>
      </div>

      {/* Overview Metric Set */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-medium text-ink-500 uppercase tracking-wider">Total Fleet</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">{totalVehicles}</div>
          <div className="text-[11px] text-ink-400 mt-1">Active Vehicles</div>
        </div>

        <div className="bg-base-900 border border-emerald-500/30 rounded-xl p-4">
          <div className="text-xs font-medium text-emerald-400 uppercase tracking-wider">Moving</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{statusCounts.moving}</div>
          <div className="text-[11px] text-ink-400 mt-1">In Transit (&gt;5 km/h)</div>
        </div>

        <div className="bg-base-900 border border-amber-500/30 rounded-xl p-4">
          <div className="text-xs font-medium text-amber-400 uppercase tracking-wider">Idle</div>
          <div className="text-2xl font-bold text-amber-400 mt-1">{statusCounts.idle}</div>
          <div className="text-[11px] text-ink-400 mt-1">Ignition On (&le;5 km/h)</div>
        </div>

        <div className="bg-base-900 border border-blue-500/30 rounded-xl p-4">
          <div className="text-xs font-medium text-blue-400 uppercase tracking-wider">Stationary</div>
          <div className="text-2xl font-bold text-blue-400 mt-1">{statusCounts.stationary}</div>
          <div className="text-[11px] text-ink-400 mt-1">Parked / Off</div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-medium text-ink-400 uppercase tracking-wider">Offline</div>
          <div className="text-2xl font-bold text-ink-300 mt-1">{statusCounts.offline}</div>
          <div className="text-[11px] text-ink-500 mt-1">No Fix &gt;2 hrs</div>
        </div>

        <div className="bg-base-900 border border-red-500/30 rounded-xl p-4">
          <div className="text-xs font-medium text-red-400 uppercase tracking-wider">In Repair</div>
          <div className="text-2xl font-bold text-red-400 mt-1">{statusCounts.under_maintenance}</div>
          <div className="text-[11px] text-ink-400 mt-1">Maintenance Workshop</div>
        </div>
      </div>

      {/* Operational & Financial Highlights */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-base-900 border border-base-700 rounded-xl p-5">
          <div className="text-sm font-medium text-ink-400">Distance Today</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">{distanceTodayKm.toLocaleString()} <span className="text-sm font-normal text-ink-400">km</span></div>
          <div className="text-xs text-ink-500 mt-2">Recorded trip logs & GPS telemetry</div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-5">
          <div className="text-sm font-medium text-ink-400">Fuel Consumed</div>
          <div className="text-2xl font-bold text-amber-400 mt-1">{fuelConsumedTodayLitres.toLocaleString()} <span className="text-sm font-normal text-ink-400">L</span></div>
          <div className="text-xs text-ink-500 mt-2">Dispensed today across depot & card</div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-5">
          <div className="text-sm font-medium text-ink-400">Fuel Expenditure</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">K {fuelCostTodayAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div className="text-xs text-ink-500 mt-2">Direct fuel spend today</div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-5">
          <div className="text-sm font-medium text-ink-400">Fleet Utilisation</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{utilisationPct}%</div>
          <div className="text-xs text-ink-500 mt-2">% active vehicles in operation</div>
        </div>
      </div>

      {/* Exception Breakdown & Quick Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Exception Severity Card */}
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-ink-100">Open Exceptions Summary</h2>
              <Link to="/exceptions" className="text-xs text-amber-400 hover:underline">View All &rarr;</Link>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-red-950/40 border border-red-800/50 rounded-lg">
                <span className="text-sm font-medium text-red-400">Critical Severity</span>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/40">{exceptions.critical}</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-amber-950/40 border border-amber-800/50 rounded-lg">
                <span className="text-sm font-medium text-amber-400">Warning Severity</span>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40">{exceptions.warning}</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-blue-950/40 border border-blue-800/50 rounded-lg">
                <span className="text-sm font-medium text-blue-400">Info / Advisory</span>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/40">{exceptions.info}</span>
              </div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-base-800 text-xs text-ink-400">
            Automated rules engine continuously checks station location proximity, tank capacity, duplicate window, and fuel card assignments.
          </div>
        </div>

        {/* Recent Open Exceptions List */}
        <div className="lg:col-span-2 bg-base-900 border border-base-700 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-ink-100">Recent Fleet Exceptions</h2>
            <Link to="/exceptions" className="text-xs text-amber-400 hover:underline">Exception Centre &rarr;</Link>
          </div>
          {exceptions.recent.length === 0 ? (
            <div className="text-sm text-ink-500 py-8 text-center">No open exceptions reported.</div>
          ) : (
            <div className="space-y-3">
              {exceptions.recent.map((exc) => (
                <div key={exc.id} className="p-3 bg-base-950 border border-base-800 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                        exc.severity === "critical"
                          ? "bg-red-500/20 text-red-400 border border-red-500/40"
                          : exc.severity === "warning"
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                          : "bg-blue-500/20 text-blue-400 border border-blue-500/40"
                      }`}>
                        {exc.severity}
                      </span>
                      <span className="text-xs font-mono font-semibold text-ink-300">{exc.rule_code}</span>
                      <span className="text-xs text-ink-400 font-medium">Vehicle: {exc.vehicle_number || "N/A"}</span>
                    </div>
                    <div className="text-sm text-ink-200">{exc.description}</div>
                  </div>
                  <Link to="/exceptions" className="text-xs btn-ghost text-amber-400 whitespace-nowrap self-end sm:self-center">
                    Investigate &rarr;
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
