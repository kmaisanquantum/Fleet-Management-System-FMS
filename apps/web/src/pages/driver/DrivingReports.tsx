import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { DriverSafety, VehicleFuelLog, VehicleTrip } from "../../types";
import StatCard from "../../components/StatCard";
import { EmptyState, PageHeader } from "./shared";

export default function DrivingReports() {
  const [trips, setTrips] = useState<VehicleTrip[]>([]);
  const [fuel, setFuel] = useState<VehicleFuelLog[]>([]);
  const [safety, setSafety] = useState<DriverSafety | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<{ data: VehicleTrip[] }>("/driver-portal/trips"),
      api.get<{ data: VehicleFuelLog[] }>("/driver-portal/fuel"),
      api.get<{ data: DriverSafety }>("/driver-portal/safety"),
    ])
      .then(([t, f, s]) => {
        setTrips(t.data || []);
        setFuel(f.data || []);
        setSafety(s.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-ink-400">Loading driving report…</div>;

  // Monthly summary derived from recorded trips (no fabricated figures).
  const byMonth = new Map<string, { km: number; trips: number }>();
  for (const t of trips) {
    const month = (t.date || "").slice(0, 7);
    if (!month) continue;
    const cur = byMonth.get(month) ?? { km: 0, trips: 0 };
    cur.km += t.total_km || 0;
    cur.trips += 1;
    byMonth.set(month, cur);
  }
  const months = Array.from(byMonth.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const totalKm = trips.reduce((a, t) => a + (t.total_km || 0), 0);
  const totalLitres = fuel.reduce((a, f) => a + (f.litres || 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="My Driving Reports" subtitle="Consolidated summary of your recorded activity" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Trips" value={`${trips.length}`} />
        <StatCard label="Total Distance" value={`${totalKm.toLocaleString()} km`} />
        <StatCard label="Total Fuel" value={`${totalLitres.toLocaleString()} L`} />
        <StatCard
          label="Safety Score"
          value={`${safety?.safetyScore ?? 0}`}
          accent={(safety?.safetyScore ?? 0) >= 80 ? "green" : (safety?.safetyScore ?? 0) >= 60 ? "amber" : "red"}
        />
      </div>

      <div className="panel overflow-x-auto">
        <div className="px-5 pt-4 font-display font-semibold text-ink-100">Monthly Summary</div>
        <table className="table-shell mt-2">
          <thead>
            <tr>
              <th>Month</th>
              <th>Trips</th>
              <th>Distance</th>
            </tr>
          </thead>
          <tbody>
            {months.map(([month, v]) => (
              <tr key={month}>
                <td>{month}</td>
                <td>{v.trips}</td>
                <td className="font-mono">{v.km.toFixed(1)} km</td>
              </tr>
            ))}
            {months.length === 0 && (
              <tr><td colSpan={3}><EmptyState>No activity recorded yet.</EmptyState></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
