import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";

interface DriverDetailData {
  profile: any;
  allocations: any[];
  trips: any[];
  fuelLogs: any[];
  exceptions: any[];
  events: any[];
  metrics: {
    safetyScore: number;
    riskRating: string;
    speedingCount: number;
    harshBrakingCount: number;
    harshAccelCount: number;
    idlingCount: number;
    openExceptionsCount: number;
  };
  summary: {
    totalTrips: number;
    totalKm: number;
    totalRefuels: number;
    totalLitres: number;
    totalFuelCost: number;
    avgKmPerL: number;
  };
}

const TABS = ["overview", "trips", "fuel", "exceptions", "events"] as const;

export default function DriverDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<DriverDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]>("overview");

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    apiGet<{ data: DriverDetailData }>(`/drivers/${id}/intelligence`)
      .then((res) => setData(res.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="p-8 text-ink-400">Loading Driver Profile…</div>;
  if (!data) return <div className="p-8 text-red-400">Driver profile not found.</div>;

  const { profile, allocations, trips, fuelLogs, exceptions, events, metrics, summary } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-base-700 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-ink-100">{profile.name}</h1>
            <span className="text-sm font-mono px-2 py-0.5 rounded bg-base-800 text-ink-300">{profile.employee_number}</span>
            <span className="px-2.5 py-0.5 rounded text-xs font-bold uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
              {profile.authorisation_status}
            </span>
          </div>
          <p className="text-sm text-ink-400 mt-1">
            {profile.department || "No department"} | Licence {profile.licence_number}
            {profile.licence_class ? ` (${profile.licence_class})` : ""}
          </p>
        </div>
        <Link to="/drivers" className="btn-secondary text-xs px-3 py-2">
          &larr; Back to Driver Register
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Safety Score</div>
          <div className={`text-2xl font-bold mt-1 ${
            metrics.safetyScore >= 80 ? "text-emerald-400" : metrics.safetyScore >= 60 ? "text-amber-400" : "text-red-400"
          }`}>
            {metrics.safetyScore} / 100
          </div>
          <div className="text-[10px] uppercase tracking-wider text-ink-500 mt-1">{metrics.riskRating} risk</div>
        </div>
        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Assigned Vehicle</div>
          {profile.assigned_vehicle_id ? (
            <Link to={`/vehicles/${profile.assigned_vehicle_id}`} className="block text-lg font-bold text-amber-400 hover:text-amber-300 mt-1">
              {profile.assigned_vehicle_number}
              <span className="block text-[10px] font-normal text-ink-500">{profile.assigned_vehicle_registration}</span>
            </Link>
          ) : (
            <div className="text-lg font-bold text-ink-500 mt-1">Unassigned</div>
          )}
        </div>
        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Trips / Distance</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">{summary.totalTrips}</div>
          <div className="text-[10px] text-ink-500 mt-1">{summary.totalKm.toLocaleString()} km logged</div>
        </div>
        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Fuel Spend</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">K{summary.totalFuelCost.toLocaleString()}</div>
          <div className="text-[10px] text-ink-500 mt-1">{summary.totalLitres.toLocaleString()} L over {summary.totalRefuels} refuels</div>
        </div>
      </div>

      <div className="flex border-b border-base-700 gap-6 text-sm overflow-x-auto">
        {TABS.map((tab) => (
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

      {activeTab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Driver Profile</h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><strong className="text-ink-400">Employee #:</strong> <span className="text-ink-200 font-mono">{profile.employee_number}</span></div>
              <div><strong className="text-ink-400">Department:</strong> <span className="text-ink-200">{profile.department || "N/A"}</span></div>
              <div><strong className="text-ink-400">Licence #:</strong> <span className="text-ink-200 font-mono">{profile.licence_number}</span></div>
              <div><strong className="text-ink-400">Licence Class:</strong> <span className="text-ink-200">{profile.licence_class || "N/A"}</span></div>
              <div><strong className="text-ink-400">Licence Expiry:</strong> <span className="text-ink-200">{profile.licence_expiry}</span></div>
              <div><strong className="text-ink-400">Status:</strong> <span className="text-ink-200 capitalize">{profile.authorisation_status}</span></div>
            </div>
          </div>

          <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Safety Events</h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><strong className="text-ink-400">Speeding:</strong> <span className="text-red-400 font-bold">{metrics.speedingCount}</span></div>
              <div><strong className="text-ink-400">Harsh Braking:</strong> <span className="text-amber-400 font-bold">{metrics.harshBrakingCount}</span></div>
              <div><strong className="text-ink-400">Harsh Acceleration:</strong> <span className="text-amber-400 font-bold">{metrics.harshAccelCount}</span></div>
              <div><strong className="text-ink-400">Excessive Idling:</strong> <span className="text-blue-400 font-bold">{metrics.idlingCount}</span></div>
              <div><strong className="text-ink-400">Open Exceptions:</strong> <span className="text-red-400 font-bold">{metrics.openExceptionsCount}</span></div>
              <div><strong className="text-ink-400">Avg Efficiency:</strong> <span className="text-ink-200 font-bold">{summary.avgKmPerL} km/L</span></div>
            </div>
          </div>

          <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4 lg:col-span-2">
            <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Allocation History</h3>
            {allocations.length === 0 ? (
              <div className="text-xs text-ink-500">No allocations recorded.</div>
            ) : (
              <div className="space-y-2 text-xs">
                {allocations.map((a) => (
                  <div key={a.id} className="p-3 bg-base-950 border border-base-800 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <Link to={`/vehicles/${a.vehicle_id}`} className="font-bold text-amber-400 hover:text-amber-300">
                        {a.vehicle_number || a.vehicle_id}
                      </Link>
                      <span className="text-ink-400"> | {a.department || "No department"}</span>
                      <div className="text-ink-500">From {a.allocation_date}{a.return_date ? ` to ${a.return_date}` : ""}</div>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      a.authorisation_status === "active" ? "bg-emerald-500/20 text-emerald-400" : "bg-base-800 text-ink-400"
                    }`}>
                      {a.authorisation_status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "trips" && (
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4 overflow-x-auto">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Recent Trips</h3>
          {trips.length === 0 ? (
            <div className="text-xs text-ink-500">No trips logged for this driver.</div>
          ) : (
            <table className="w-full text-left text-xs text-ink-200">
              <thead className="bg-base-950 text-ink-400 uppercase">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Vehicle</th>
                  <th className="px-3 py-2">Route</th>
                  <th className="px-3 py-2">Purpose</th>
                  <th className="px-3 py-2">Distance</th>
                  <th className="px-3 py-2">Anomaly</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-800">
                {trips.map((t) => (
                  <tr key={t.id}>
                    <td className="px-3 py-2">{t.date}</td>
                    <td className="px-3 py-2">
                      <Link to={`/vehicles/${t.vehicle_id}`} className="text-amber-400 hover:text-amber-300">{t.vehicle_number}</Link>
                    </td>
                    <td className="px-3 py-2">{t.start_location} &rarr; {t.destination}</td>
                    <td className="px-3 py-2">{t.purpose || "—"}</td>
                    <td className="px-3 py-2 font-mono">{t.total_km} km</td>
                    <td className="px-3 py-2">{t.odometer_anomaly === 1 ? <span className="text-red-400 font-bold">FLAGGED</span> : "Normal"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === "fuel" && (
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4 overflow-x-auto">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Recent Fuel Logs</h3>
          {fuelLogs.length === 0 ? (
            <div className="text-xs text-ink-500">No fuel logs recorded for this driver.</div>
          ) : (
            <table className="w-full text-left text-xs text-ink-200">
              <thead className="bg-base-950 text-ink-400 uppercase">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Vehicle</th>
                  <th className="px-3 py-2">Station</th>
                  <th className="px-3 py-2">Litres</th>
                  <th className="px-3 py-2">Cost</th>
                  <th className="px-3 py-2">Efficiency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-800">
                {fuelLogs.map((f) => (
                  <tr key={f.id}>
                    <td className="px-3 py-2">{f.date}</td>
                    <td className="px-3 py-2">
                      <Link to={`/vehicles/${f.vehicle_id}`} className="text-amber-400 hover:text-amber-300">{f.vehicle_number}</Link>
                    </td>
                    <td className="px-3 py-2">{f.station || "—"}</td>
                    <td className="px-3 py-2 font-mono">{f.litres} L</td>
                    <td className="px-3 py-2 font-mono">K{Number(f.total_cost).toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono">{f.km_per_l ? `${f.km_per_l} km/L` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === "exceptions" && (
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Linked Exceptions</h3>
          {exceptions.length === 0 ? (
            <div className="text-xs text-ink-500">No exceptions linked to this driver.</div>
          ) : (
            <div className="space-y-3 text-xs">
              {exceptions.map((exc) => (
                <div key={exc.id} className="p-3 bg-base-950 border border-base-800 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-red-400">{exc.rule_code}: {exc.description}</div>
                    <div className="text-ink-400">
                      {exc.vehicle_number ? (
                        <Link to={`/vehicles/${exc.vehicle_id}`} className="text-amber-400 hover:text-amber-300">{exc.vehicle_number}</Link>
                      ) : "No vehicle"}
                      {" | "}{new Date(exc.created_at).toLocaleString()}
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-base-800 text-amber-400 uppercase font-bold text-[10px]">{exc.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "events" && (
        <div className="bg-base-900 border border-base-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Recent Telemetry Events</h3>
          {events.length === 0 ? (
            <div className="text-xs text-ink-500">No telemetry events recorded for this driver.</div>
          ) : (
            <div className="space-y-2 text-xs">
              {events.map((ev) => (
                <div key={ev.id} className="p-3 bg-base-950 border border-base-800 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <span className="font-bold text-amber-400 uppercase">{ev.event_type.replace(/_/g, " ")}</span>
                    {ev.vehicle_number ? (
                      <span className="text-ink-400"> | <Link to={`/vehicles/${ev.vehicle_id}`} className="text-amber-400 hover:text-amber-300">{ev.vehicle_number}</Link></span>
                    ) : null}
                    <div className="text-ink-500">{new Date(ev.recorded_at).toLocaleString()}</div>
                  </div>
                  <span className="font-mono text-ink-200">{ev.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
