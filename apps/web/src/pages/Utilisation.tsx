import { useEffect, useState } from "react";
import { apiGet } from "../api/client";

interface UtilisationData {
  summary: {
    totalTrips: number;
    totalDistanceKm: number;
    activeVehiclesCount: number;
    totalVehiclesCount: number;
  };
  byDepartment: { department: string; tripsCount: number; distanceKm: number }[];
  byVehicleType: { vehicleType: string; tripsCount: number; distanceKm: number }[];
  vehicleUtilisation: {
    vehicleId: string;
    vehicleNumber: string;
    registrationNumber: string;
    department: string;
    vehicleType: string;
    currentOdometer: number;
    tripsCount: number;
    distanceKm: number;
  }[];
}

export default function Utilisation() {
  const [data, setData] = useState<UtilisationData | null>(null);
  const [loading, setLoading] = useState(true);

  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    loadUtilisation();
  }, [departmentFilter, typeFilter]);

  async function loadUtilisation() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (departmentFilter !== "all") params.append("department", departmentFilter);
      if (typeFilter !== "all") params.append("type", typeFilter);

      const res = await apiGet<{ data: UtilisationData }>(`/fleet/utilisation?${params.toString()}`);
      setData(res.data);
    } catch (err) {
      console.error("Failed to load utilisation data:", err);
    } finally {
      setLoading(false);
    }
  }

  if (loading || !data) {
    return <div className="p-8 text-ink-400">Loading fleet utilisation analytics…</div>;
  }

  const { summary, byDepartment, byVehicleType, vehicleUtilisation } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-ink-100">Fleet Utilisation Analytics</h1>
        <p className="text-sm text-ink-400">Multi-dimensional distance, trip frequency, and operational hours breakdown</p>
      </div>

      {/* Summary Highlights */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Total Trips</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">{summary.totalTrips}</div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Total Distance</div>
          <div className="text-2xl font-bold text-amber-400 mt-1">{summary.totalDistanceKm.toLocaleString()} <span className="text-xs font-normal text-ink-400">km</span></div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Operating Vehicles</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{summary.activeVehiclesCount} / {summary.totalVehiclesCount}</div>
        </div>

        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Utilisation Rate</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">
            {summary.totalVehiclesCount > 0 ? ((summary.activeVehiclesCount / summary.totalVehiclesCount) * 100).toFixed(1) : 0}%
          </div>
        </div>
      </div>

      {/* Breakdown Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* By Department */}
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-ink-100 uppercase tracking-wider">Distance by Department</h3>
          <div className="space-y-3">
            {byDepartment.map((d) => (
              <div key={d.department} className="space-y-1">
                <div className="flex justify-between text-xs text-ink-200">
                  <span className="font-medium">{d.department}</span>
                  <span className="font-mono text-amber-400">{d.distanceKm} km ({d.tripsCount} trips)</span>
                </div>
                <div className="w-full bg-base-950 h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-amber-400 h-full rounded-full"
                    style={{
                      width: `${summary.totalDistanceKm > 0 ? (d.distanceKm / summary.totalDistanceKm) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* By Vehicle Type */}
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-ink-100 uppercase tracking-wider">Distance by Vehicle Type</h3>
          <div className="space-y-3">
            {byVehicleType.map((t) => (
              <div key={t.vehicleType} className="space-y-1">
                <div className="flex justify-between text-xs text-ink-200">
                  <span className="font-medium">{t.vehicleType}</span>
                  <span className="font-mono text-emerald-400">{t.distanceKm} km ({t.tripsCount} trips)</span>
                </div>
                <div className="w-full bg-base-950 h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-400 h-full rounded-full"
                    style={{
                      width: `${summary.totalDistanceKm > 0 ? (t.distanceKm / summary.totalDistanceKm) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Vehicle Utilisation Table */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-x-auto">
        <div className="p-4 border-b border-base-700 font-semibold text-sm text-ink-100">
          Individual Vehicle Utilisation Rankings
        </div>
        <table className="w-full text-left text-xs text-ink-200">
          <thead className="bg-base-950 text-ink-400 border-b border-base-700 uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3">Vehicle</th>
              <th className="px-4 py-3">Department</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Current Odometer</th>
              <th className="px-4 py-3">Trips Count</th>
              <th className="px-4 py-3">Distance Travelled</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800">
            {vehicleUtilisation.map((v) => (
              <tr key={v.vehicleId} className="hover:bg-base-800/40">
                <td className="px-4 py-3 font-semibold text-ink-100 whitespace-nowrap">{v.vehicleNumber} ({v.registrationNumber})</td>
                <td className="px-4 py-3 whitespace-nowrap">{v.department}</td>
                <td className="px-4 py-3 whitespace-nowrap">{v.vehicleType}</td>
                <td className="px-4 py-3 whitespace-nowrap font-mono">{v.currentOdometer?.toLocaleString()} km</td>
                <td className="px-4 py-3 whitespace-nowrap font-mono">{v.tripsCount}</td>
                <td className="px-4 py-3 whitespace-nowrap font-mono font-bold text-amber-400">{v.distanceKm} km</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
