import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { DriverSafety } from "../../types";
import StatCard from "../../components/StatCard";
import { PageHeader } from "./shared";

export default function SafetyScore() {
  const [safety, setSafety] = useState<DriverSafety | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ data: DriverSafety }>("/driver-portal/safety")
      .then((res) => setSafety(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-ink-400">Loading safety score…</div>;
  if (!safety) return <div className="p-4 text-signal-red">Unable to load safety data.</div>;

  const accent = safety.safetyScore >= 80 ? "green" : safety.safetyScore >= 60 ? "amber" : "red";
  const maxTotal = Math.max(1, ...safety.monthlyTrend.map((m) => m.total));

  return (
    <div className="space-y-6">
      <PageHeader title="Safety Score" subtitle="Your current safety rating, derived from recorded driving events" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Safety Score" value={`${safety.safetyScore}`} sublabel={`${safety.riskRating} risk`} accent={accent as any} />
        <StatCard label="Total Events" value={`${safety.totalEvents}`} />
        <StatCard label="Speeding" value={`${safety.speedingCount}`} accent={safety.speedingCount > 0 ? "red" : "green"} />
        <StatCard label="Open Exceptions" value={`${safety.openExceptions}`} accent={safety.openExceptions > 0 ? "amber" : "green"} />
      </div>

      <div className="panel p-5">
        <h2 className="font-display font-semibold text-ink-100 mb-4">Monthly Trend</h2>
        {safety.monthlyTrend.length === 0 ? (
          <div className="text-sm text-ink-500">No recorded events.</div>
        ) : (
          <div className="space-y-3">
            {safety.monthlyTrend.map((m) => (
              <div key={m.month}>
                <div className="flex items-center justify-between text-xs text-ink-400 mb-1">
                  <span>{m.month}</span>
                  <span>{m.total} events</span>
                </div>
                <div className="h-2 bg-base-900 rounded overflow-hidden">
                  <div className="h-full bg-amber-400" style={{ width: `${(m.total / maxTotal) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
