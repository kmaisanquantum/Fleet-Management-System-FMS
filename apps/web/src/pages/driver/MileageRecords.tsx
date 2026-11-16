import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { VehicleTrip } from "../../types";
import StatCard from "../../components/StatCard";
import { EmptyState, PageHeader } from "./shared";

export default function MileageRecords() {
  const [trips, setTrips] = useState<VehicleTrip[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ data: VehicleTrip[] }>("/driver-portal/trips")
      .then((res) => setTrips(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-ink-400">Loading mileage records…</div>;

  // Aggregate distance by day (derived from recorded trips only).
  const byDay = new Map<string, { km: number; trips: number }>();
  for (const t of trips) {
    const cur = byDay.get(t.date) ?? { km: 0, trips: 0 };
    cur.km += t.total_km || 0;
    cur.trips += 1;
    byDay.set(t.date, cur);
  }
  const days = Array.from(byDay.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const totalKm = trips.reduce((a, t) => a + (t.total_km || 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Mileage Records" subtitle="Distance covered derived from your recorded trips" />
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Total Distance" value={`${totalKm.toLocaleString()} km`} />
        <StatCard label="Days with Activity" value={`${days.length}`} />
      </div>
      <div className="panel overflow-x-auto">
        <table className="table-shell">
          <thead>
            <tr>
              <th>Date</th>
              <th>Trips</th>
              <th>Distance</th>
            </tr>
          </thead>
          <tbody>
            {days.map(([date, v]) => (
              <tr key={date}>
                <td>{date}</td>
                <td>{v.trips}</td>
                <td className="font-mono">{v.km.toFixed(1)} km</td>
              </tr>
            ))}
            {days.length === 0 && (
              <tr><td colSpan={3}><EmptyState>No mileage recorded yet.</EmptyState></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
