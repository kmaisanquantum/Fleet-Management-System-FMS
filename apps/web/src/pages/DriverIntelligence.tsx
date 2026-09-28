import { useEffect, useState } from "react";
import { apiGet } from "../api/client";

interface DriverProfile {
  id: string;
  employeeNumber: string;
  name: string;
  department: string;
  licenceNumber: string;
  licenceClass: string;
  licenceExpiry: string;
  authorisationStatus: string;
  assignedVehicle: string;
  metrics: {
    safetyScore: number;
    riskRating: "low" | "medium" | "high";
    speedingCount: number;
    harshBrakingCount: number;
    harshAccelCount: number;
    idlingCount: number;
    avgKmL: number;
    totalFuelCost: number;
    openExceptionsCount: number;
  };
  recentEvents: any[];
}

interface IntelligenceResponse {
  data: DriverProfile[];
  summary: {
    totalDrivers: number;
    highRiskCount: number;
    avgFleetSafetyScore: number;
    topPerformers: DriverProfile[];
  };
}

export default function DriverIntelligence() {
  const [data, setData] = useState<DriverProfile[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDriverData();
  }, []);

  async function loadDriverData() {
    setLoading(true);
    try {
      const res = await apiGet<IntelligenceResponse>("/driver-intelligence");
      setData(res.data);
      setSummary(res.summary);
    } catch (err) {
      console.error("Failed to load driver intelligence:", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-ink-100">Driver Intelligence & Behaviour</h1>
        <p className="text-sm text-ink-400">Driver safety scoring, speeding/harsh braking telemetry logs, and risk rankings</p>
      </div>

      {/* Summary Highlights */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-base-900 border border-base-700 rounded-xl p-4">
            <div className="text-xs font-semibold text-ink-500 uppercase">Total Drivers</div>
            <div className="text-2xl font-bold text-ink-100 mt-1">{summary.totalDrivers}</div>
          </div>

          <div className="bg-base-900 border border-emerald-500/30 rounded-xl p-4">
            <div className="text-xs font-semibold text-emerald-400 uppercase">Avg Safety Score</div>
            <div className="text-2xl font-bold text-emerald-400 mt-1">{summary.avgFleetSafetyScore} / 100</div>
          </div>

          <div className="bg-base-900 border border-red-500/30 rounded-xl p-4">
            <div className="text-xs font-semibold text-red-400 uppercase">High Risk Drivers</div>
            <div className="text-2xl font-bold text-red-400 mt-1">{summary.highRiskCount}</div>
          </div>
        </div>
      )}

      {/* Drivers List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loading ? (
          <div className="col-span-2 text-center p-8 text-ink-400">Loading driver scorecards…</div>
        ) : (
          data.map((driver) => (
            <div key={driver.id} className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-xs text-amber-400 font-mono font-semibold">{driver.employeeNumber}</div>
                  <h3 className="text-lg font-bold text-ink-100">{driver.name}</h3>
                  <div className="text-xs text-ink-400">{driver.department} | {driver.assignedVehicle}</div>
                </div>
                <div className="text-right">
                  <div className={`text-2xl font-bold ${
                    driver.metrics.safetyScore >= 80 ? "text-emerald-400" : driver.metrics.safetyScore >= 60 ? "text-amber-400" : "text-red-400"
                  }`}>
                    {driver.metrics.safetyScore}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-ink-500">Safety Score</div>
                </div>
              </div>

              {/* Event Telemetry Grid */}
              <div className="grid grid-cols-4 gap-2 bg-base-950 p-3 rounded-lg text-center text-xs border border-base-800">
                <div>
                  <div className="text-ink-400 font-semibold">Speeding</div>
                  <div className="text-sm font-bold text-red-400 mt-0.5">{driver.metrics.speedingCount}</div>
                </div>
                <div>
                  <div className="text-ink-400 font-semibold">Harsh Brake</div>
                  <div className="text-sm font-bold text-amber-400 mt-0.5">{driver.metrics.harshBrakingCount}</div>
                </div>
                <div>
                  <div className="text-ink-400 font-semibold">Harsh Accel</div>
                  <div className="text-sm font-bold text-amber-400 mt-0.5">{driver.metrics.harshAccelCount}</div>
                </div>
                <div>
                  <div className="text-ink-400 font-semibold">Idling</div>
                  <div className="text-sm font-bold text-blue-400 mt-0.5">{driver.metrics.idlingCount}</div>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs pt-2 border-t border-base-800 text-ink-400">
                <span>Avg Efficiency: <strong className="text-ink-200">{driver.metrics.avgKmL} km/L</strong></span>
                <span>Open Exceptions: <strong className="text-red-400">{driver.metrics.openExceptionsCount}</strong></span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
