import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { DriverSafety } from "../../types";
import { EmptyState, PageHeader } from "./shared";

const LABELS: Record<string, string> = {
  speeding: "Speeding",
  harsh_braking: "Harsh Braking",
  harsh_accel: "Harsh Acceleration",
  excessive_idling: "Excessive Idling",
};

export default function DrivingBehaviour() {
  const [safety, setSafety] = useState<DriverSafety | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ data: DriverSafety }>("/driver-portal/safety")
      .then((res) => setSafety(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-ink-400">Loading driving behaviour…</div>;
  if (!safety) return <div className="p-4 text-signal-red">Unable to load behaviour data.</div>;

  const breakdown = [
    { label: "Speeding", count: safety.speedingCount, cls: "bg-signal-red" },
    { label: "Harsh Braking", count: safety.harshBrakingCount, cls: "bg-amber-400" },
    { label: "Harsh Acceleration", count: safety.harshAccelCount, cls: "bg-amber-400" },
    { label: "Excessive Idling", count: safety.idlingCount, cls: "bg-ink-500" },
  ];
  const max = Math.max(1, ...breakdown.map((b) => b.count));

  return (
    <div className="space-y-6">
      <PageHeader title="Driving Behaviour" subtitle="Event breakdown recorded by fleet telemetry" />

      <div className="panel p-5 space-y-3">
        {breakdown.map((b) => (
          <div key={b.label}>
            <div className="flex items-center justify-between text-sm text-ink-300 mb-1">
              <span>{b.label}</span>
              <span className="font-mono">{b.count}</span>
            </div>
            <div className="h-2 bg-base-900 rounded overflow-hidden">
              <div className={`h-full ${b.cls}`} style={{ width: `${(b.count / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="panel overflow-x-auto">
        <div className="px-5 pt-4 font-display font-semibold text-ink-100">Recent Events</div>
        <table className="table-shell mt-2">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {safety.recentEvents.map((e) => (
              <tr key={e.id}>
                <td>{e.recorded_at}</td>
                <td>{LABELS[e.event_type] ?? e.event_type}</td>
                <td className="font-mono">{e.value}</td>
              </tr>
            ))}
            {safety.recentEvents.length === 0 && (
              <tr><td colSpan={3}><EmptyState>No recorded events.</EmptyState></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
