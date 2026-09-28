import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { apiGet } from "../api/client";

export default function VehicleDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"profile" | "operational" | "fuel" | "maintenance" | "driver" | "exceptions">("profile");

  useEffect(() => {
    if (id) loadVehicleIntelligence();
  }, [id]);

  async function loadVehicleIntelligence() {
    setLoading(true);
    try {
      const res = await apiGet<{ data: any }>(`/vehicles/${id}/intelligence`);
      setData(res.data);
    } catch (err) {
      console.error("Failed to load vehicle intelligence:", err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <div className="p-8 text-ink-400">Loading Vehicle Profile & Intelligence…</div>;
  }

  if (!data) {
    return <div className="p-8 text-red-400">Vehicle intelligence profile not found.</div>;
  }

  const { profile, operational, fuel, maintenance, driver, exceptions } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-base-700 pb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-ink-100">{profile.vehicle_number}</h1>
            <span className="text-sm font-mono px-2 py-0.5 rounded bg-base-800 text-ink-300">{profile.registration_number}</span>
            <span className="px-2.5 py-0.5 rounded text-xs font-bold uppercase bg-amber-500/20 text-amber-400 border border-amber-500/40">
              {operational.currentStatus}
            </span>
          </div>
          <p className="text-sm text-ink-400 mt-1">{profile.make} {profile.model} ({profile.year}) | {profile.department} Department</p>
        </div>
        <Link to="/vehicles" className="btn-secondary text-xs px-3 py-2">
          &larr; Back to Vehicles Register
        </Link>
      </div>

      {/* Tabs Bar */}
      <div className="flex border-b border-base-700 gap-6 text-sm overflow-x-auto">
        {(["profile", "operational", "fuel", "maintenance", "driver", "exceptions"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`pb-3 uppercase tracking-wider font-semibold text-xs border-b-2 transition-colors whitespace-nowrap ${
              activeTab === tab ? "border-amber-400 text-amber-400" : "border-transparent text-ink-400 hover:text-ink-200"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Contents */}
      {activeTab === "profile" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Specifications & Hardware</h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><strong className="text-ink-400">Chassis / VIN:</strong> <span className="text-ink-200 font-mono">{profile.chassis_vin || "N/A"}</span></div>
              <div><strong className="text-ink-400">Engine Number:</strong> <span className="text-ink-200 font-mono">{profile.engine_number || "N/A"}</span></div>
              <div><strong className="text-ink-400">Fuel Type:</strong> <span className="text-ink-200">{profile.fuel_type}</span></div>
              <div><strong className="text-ink-400">Tank Capacity:</strong> <span className="text-ink-200 font-bold">{profile.tank_capacity_litres} L</span></div>
              <div><strong className="text-ink-400">Expected Rating:</strong> <span className="text-ink-200 font-bold">{profile.expected_km_per_l} km/L</span></div>
              <div><strong className="text-ink-400">Ownership:</strong> <span className="text-ink-200 capitalize">{profile.ownership}</span></div>
            </div>
          </div>

          <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Assigned Hardware & Telematics</h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><strong className="text-ink-400">Fuel Card:</strong> <span className="text-amber-400 font-mono">{profile.card_number || "Unassigned"}</span></div>
              <div><strong className="text-ink-400">GPS Device Identifier:</strong> <span className="text-emerald-400 font-mono">{profile.device_identifier || "Unassigned"}</span></div>
              <div><strong className="text-ink-400">Insurance Policy:</strong> <span className="text-ink-200">{profile.insurance_policy || "N/A"}</span></div>
              <div><strong className="text-ink-400">Insurance Expiry:</strong> <span className="text-ink-200">{profile.insurance_expiry || "N/A"}</span></div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "operational" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Telemetry & Odometer</h3>
            <div className="space-y-2 text-xs">
              <div><strong className="text-ink-400">Current Odometer:</strong> <span className="text-lg font-bold text-ink-100">{profile.current_odometer?.toLocaleString()} km</span></div>
              <div><strong className="text-ink-400">Last GPS Fix:</strong> <span className="text-ink-200">{profile.last_gps_fix_at || "N/A"}</span></div>
              <div><strong className="text-ink-400">Coordinates:</strong> <span className="text-ink-200 font-mono">{profile.current_latitude}, {profile.current_longitude}</span></div>
            </div>
          </div>

          <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Trip Summary</h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><strong className="text-ink-400">Total Trips Logged:</strong> <span className="text-sm font-bold text-ink-100">{operational.tripSummary?.total_trips || 0}</span></div>
              <div><strong className="text-ink-400">Distance Travelled:</strong> <span className="text-sm font-bold text-amber-400">{operational.tripSummary?.total_distance_km || 0} km</span></div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "fuel" && (
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Refuel History & Reconciliation</h3>
          <table className="w-full text-left text-xs text-ink-200">
            <thead className="bg-base-950 text-ink-400 uppercase">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Station</th>
                <th className="px-3 py-2">Litres</th>
                <th className="px-3 py-2">Total Cost</th>
                <th className="px-3 py-2">Efficiency</th>
                <th className="px-3 py-2">Reconciliation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-800">
              {fuel.recentLogs.map((fl: any) => (
                <tr key={fl.id}>
                  <td className="px-3 py-2">{fl.date}</td>
                  <td className="px-3 py-2">{fl.station_name || fl.station}</td>
                  <td className="px-3 py-2 font-mono">{fl.litres} L</td>
                  <td className="px-3 py-2 font-mono">K {fl.total_cost}</td>
                  <td className="px-3 py-2 font-mono">{fl.km_per_l ? `${fl.km_per_l} km/L` : "N/A"}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      fl.reconciliation_status === "verified" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
                    }`}>
                      {fl.reconciliation_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "maintenance" && (
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Maintenance & Service Log</h3>
          {maintenance.records.length === 0 ? (
            <div className="text-xs text-ink-500">No maintenance records logged.</div>
          ) : (
            <div className="space-y-3">
              {maintenance.records.map((m: any) => (
                <div key={m.id} className="p-3 bg-base-950 border border-base-800 rounded-lg text-xs flex justify-between items-center">
                  <div>
                    <div className="font-bold text-ink-100">{m.description}</div>
                    <div className="text-ink-400">{m.maintenance_type} | Scheduled: {m.scheduled_date}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-base-800 text-amber-400 uppercase font-bold text-[10px]">{m.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "driver" && (
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Allocated Drivers</h3>
          {driver.allocations.length === 0 ? (
            <div className="text-xs text-ink-500">No driver allocations.</div>
          ) : (
            <div className="space-y-3 text-xs">
              {driver.allocations.map((a: any) => (
                <div key={a.id} className="p-3 bg-base-950 border border-base-800 rounded-lg flex justify-between items-center">
                  <div>
                    <div className="font-bold text-ink-100">{a.driver_name} ({a.employee_number})</div>
                    <div className="text-ink-400">Allocated: {a.allocation_date}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold uppercase text-[10px]">{a.authorisation_status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "exceptions" && (
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Fleet Exceptions for Vehicle</h3>
          {exceptions.length === 0 ? (
            <div className="text-xs text-ink-500">No exceptions logged for this vehicle.</div>
          ) : (
            <div className="space-y-3 text-xs">
              {exceptions.map((exc: any) => (
                <div key={exc.id} className="p-3 bg-base-950 border border-base-800 rounded-lg flex justify-between items-center">
                  <div>
                    <div className="font-bold text-red-400">{exc.rule_code}: {exc.description}</div>
                    <div className="text-ink-400">{new Date(exc.created_at).toLocaleString()}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-base-800 text-amber-400 uppercase font-bold text-[10px]">{exc.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
