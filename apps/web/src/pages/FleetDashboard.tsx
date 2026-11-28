import { useCallback, useEffect, useState } from "react";
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

type InsightSeverity = "critical" | "warning" | "info";

interface FleetInsight {
  id: string;
  severity: InsightSeverity;
  category: string;
  title: string;
  detail: string;
  recommendation: string;
  actionLabel: string;
  actionHref: string;
  dueAt?: string;
  metric?: number;
}

interface FleetHealthComponent {
  key: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

interface FleetIntelligence {
  generatedAt: string;
  health: {
    score: number;
    grade: "excellent" | "good" | "attention" | "critical";
    label: string;
    components: FleetHealthComponent[];
  };
  summary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
  };
  coverage: {
    vehicles: number;
    onlineVehicles: number;
    drivers: number;
    cameras: number;
    onlineCameras: number;
  };
  insights: FleetInsight[];
}

const SEVERITY_STYLES: Record<InsightSeverity, string> = {
  critical: "bg-red-500/20 text-red-400 border border-red-500/40",
  warning: "bg-amber-500/20 text-amber-400 border border-amber-500/40",
  info: "bg-blue-500/20 text-blue-400 border border-blue-500/40",
};

const GRADE_COLORS: Record<FleetIntelligence["health"]["grade"], string> = {
  excellent: "#34d399",
  good: "#60a5fa",
  attention: "#fbbf24",
  critical: "#f87171",
};

function scoreColor(score: number): string {
  if (score >= 80) return "bg-emerald-400";
  if (score >= 60) return "bg-amber-400";
  return "bg-red-400";
}

function formatPgtTime(date: Date | null): string {
  if (!date) return "—";
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: "Pacific/Port_Moresby",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)} PGT`;
}

export default function FleetDashboard() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [intelligence, setIntelligence] = useState<FleetIntelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intelligenceError, setIntelligenceError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadDashboard = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    const [overviewResult, insightsResult] = await Promise.allSettled([
      apiGet<{ data: OverviewData }>("/fleet/overview"),
      apiGet<{ data: FleetIntelligence }>("/fleet/insights?limit=8"),
    ]);

    if (overviewResult.status === "fulfilled") {
      setData(overviewResult.value.data);
      setError(null);
    } else {
      setError((overviewResult.reason as any)?.message || "Failed to load fleet overview");
    }

    if (insightsResult.status === "fulfilled") {
      setIntelligence(insightsResult.value.data);
      setIntelligenceError(null);
    } else {
      setIntelligenceError((insightsResult.reason as any)?.message || "Failed to load fleet intelligence");
    }

    setLastUpdated(new Date());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void loadDashboard();
    const timer = setInterval(() => void loadDashboard(true), 60_000);
    return () => clearInterval(timer);
  }, [loadDashboard]);

  if (loading && !data) {
    return <div className="p-8 text-ink-400">Loading Fleet Intelligence Overview…</div>;
  }

  if (!data) {
    return (
      <div className="p-8 space-y-4">
        <div className="text-red-400">Error loading fleet overview: {error || "No data available"}</div>
        <button onClick={() => void loadDashboard()} className="btn-secondary text-sm px-4 py-2 rounded-lg">
          Retry
        </button>
      </div>
    );
  }

  const { totalVehicles, statusCounts, distanceTodayKm, fuelConsumedTodayLitres, fuelCostTodayAmount, utilisationPct, exceptions } = data;
  const health = intelligence?.health;
  const healthColor = health ? GRADE_COLORS[health.grade] : "#fbbf24";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Fleet Overview & Intelligence</h1>
          <p className="text-sm text-ink-400">Real-time status, ranked operating risks, and automated fuel reconciliation</p>
          <p className="text-[11px] text-ink-500 mt-1">Updated {formatPgtTime(lastUpdated)} · auto-refresh 60s</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void loadDashboard(true)}
            disabled={refreshing}
            className="btn-secondary text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <Link to="/live-map" className="btn-amber text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-2">
            <span>🗺️ Live Map View</span>
          </Link>
          <Link to="/exceptions" className="btn-secondary text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-2">
            <span>🚨 Exception Centre ({exceptions.totalOpen})</span>
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
          Showing the last successful overview. Refresh failed: {error}
        </div>
      )}
      {intelligenceError && (
        <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
          Intelligence briefing is temporarily unavailable: {intelligenceError}
        </div>
      )}

      {/* Health score + ranked briefing */}
      {intelligence && health && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-base-900 border border-base-700 rounded-xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-ink-500 uppercase tracking-wider">Fleet Health</div>
                <div className="text-sm text-ink-400 mt-1">Telemetry, compliance, safety and asset signals</div>
              </div>
              <div className="text-right text-[11px] text-ink-500 whitespace-nowrap">
                {intelligence.coverage.onlineVehicles}/{intelligence.coverage.vehicles} online
                <br />
                {intelligence.coverage.cameras > 0
                  ? `${intelligence.coverage.onlineCameras}/${intelligence.coverage.cameras} cameras`
                  : "No cameras"}
              </div>
            </div>

            <div className="flex items-center gap-4 mt-5">
              <div
                className="relative h-24 w-24 shrink-0 rounded-full"
                style={{ background: `conic-gradient(${healthColor} ${health.score * 3.6}deg, #1f2937 0deg)` }}
              >
                <div className="absolute inset-[6px] rounded-full bg-base-900 flex flex-col items-center justify-center">
                  <span className="text-2xl font-bold text-ink-100">{health.score}</span>
                  <span className="text-[9px] uppercase tracking-wider text-ink-500">score</span>
                </div>
              </div>
              <div>
                <div className="text-xl font-bold" style={{ color: healthColor }}>{health.label}</div>
                <div className="text-xs text-ink-400 mt-1">{health.score}/100 weighted fleet health</div>
                <div className="text-[11px] text-ink-500 mt-1">
                  {intelligence.summary.critical} critical · {intelligence.summary.warning} warning actions
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-5">
              {health.components.map((component) => (
                <div key={component.key}>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-ink-400">{component.label}</span>
                    <span className="font-semibold text-ink-200">{component.score}</span>
                  </div>
                  <div className="h-1.5 bg-base-800 rounded-full mt-1 overflow-hidden">
                    <div className={`h-full rounded-full ${scoreColor(component.score)}`} style={{ width: `${component.score}%` }} />
                  </div>
                  <div className="text-[10px] text-ink-500 mt-1 truncate" title={component.detail}>{component.detail}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2 bg-base-900 border border-base-700 rounded-xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-ink-100">Intelligence Briefing</h2>
                <p className="text-xs text-ink-400 mt-1">
                  Ranked actions from exceptions, maintenance, compliance, fuel and driver signals.
                </p>
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/40">
                  {intelligence.summary.critical} critical
                </span>
                <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40">
                  {intelligence.summary.warning} warning
                </span>
              </div>
            </div>

            {intelligence.insights.length === 0 ? (
              <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/20 px-4 py-8 text-center">
                <div className="text-sm font-medium text-emerald-300">No recommended actions right now.</div>
                <div className="text-xs text-ink-400 mt-1">
                  Telemetry, maintenance, compliance, fuel and driver signals are within operating thresholds.
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {intelligence.insights.slice(0, 6).map((insight) => (
                  <div key={insight.id} className="p-3 bg-base-950 border border-base-800 rounded-lg">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 ${SEVERITY_STYLES[insight.severity]}`}>
                          {insight.severity}
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-ink-100">{insight.title}</div>
                          <div className="text-xs text-ink-400 mt-1">{insight.detail}</div>
                          <div className="text-[11px] text-ink-500 mt-1">{insight.recommendation}</div>
                        </div>
                      </div>
                      <Link to={insight.actionHref} className="text-xs text-amber-400 hover:text-amber-300 whitespace-nowrap self-end sm:self-start">
                        {insight.actionLabel} &rarr;
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Overview Metric Set */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-medium text-ink-500 uppercase tracking-wider">Total Fleet</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">{totalVehicles}</div>
          <div className="text-[11px] text-ink-400 mt-1">Registered (excl. disposed)</div>
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
          <div className="text-xs text-ink-500 mt-2">Recorded trips today (PGT)</div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-5">
          <div className="text-sm font-medium text-ink-400">Fuel Consumed</div>
          <div className="text-2xl font-bold text-amber-400 mt-1">{fuelConsumedTodayLitres.toLocaleString()} <span className="text-sm font-normal text-ink-400">L</span></div>
          <div className="text-xs text-ink-500 mt-2">Dispensed today across depot & card (PGT)</div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-5">
          <div className="text-sm font-medium text-ink-400">Fuel Expenditure</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">K {fuelCostTodayAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div className="text-xs text-ink-500 mt-2">Direct fuel spend today (PGT)</div>
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
