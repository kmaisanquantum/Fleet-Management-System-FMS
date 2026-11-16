import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { DriverDashboard as DashboardData } from "../../types";
import StatCard from "../../components/StatCard";
import { PageHeader, StatusBadge } from "./shared";

export default function DriverDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ data: DashboardData }>("/driver-portal/dashboard")
      .then((res) => setData(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-ink-400">Loading dashboard…</div>;
  if (!data) return <div className="p-4 text-signal-red">Unable to load your dashboard.</div>;

  const m = data.metrics;
  const v = data.assignedVehicle;

  return (
    <div className="space-y-6">
      <PageHeader title="My Dashboard" subtitle="Your vehicle, trips and safety at a glance" />

      {data.vehicleBlockReason && (
        <div className="panel p-4 border-signal-red/60 bg-red-950/30">
          <div className="text-sm font-semibold text-signal-red">Vehicle unavailable</div>
          <div className="text-sm text-ink-200 mt-1">{data.vehicleBlockReason}. Trips cannot be started until an administrator clears it.</div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Distance" value={`${m.totalKm.toLocaleString()} km`} />
        <StatCard label="Fuel Used" value={`${m.totalFuelLitres.toLocaleString()} L`} sublabel={`${m.totalFuelCost.toLocaleString()} cost`} />
        <StatCard label="Avg Consumption" value={`${m.avgKmPerL} km/L`} />
        <StatCard
          label="Safety Score"
          value={`${m.safetyScore}`}
          sublabel={`${m.riskRating} risk`}
          accent={m.safetyScore >= 80 ? "green" : m.safetyScore >= 60 ? "amber" : "red"}
        />
        <StatCard label="Pending Inspections" value={`${m.pendingInspections}`} accent={m.pendingInspections > 0 ? "amber" : "green"} />
        <StatCard label="Open Faults" value={`${m.openFaults}`} accent={m.openFaults > 0 ? "red" : "green"} />
        <StatCard label="Unread Notifications" value={`${m.unreadNotifications}`} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="panel p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display font-semibold text-ink-100">My Assigned Vehicle</h2>
            <Link to="/portal/vehicle" className="text-xs text-amber-400 hover:underline">View</Link>
          </div>
          {v ? (
            <div className="space-y-1 text-sm text-ink-200">
              <div className="text-lg font-semibold text-amber-400">{v.vehicle_number}</div>
              <div>{v.make} {v.model} · {v.vehicle_type}</div>
              <div className="text-ink-400">Reg: {v.registration_number}</div>
              <div className="text-ink-400">Odometer: {v.current_odometer.toLocaleString()} km</div>
              <div className="pt-1"><StatusBadge value={v.status} /></div>
            </div>
          ) : (
            <div className="text-sm text-ink-500">No vehicle is currently assigned to you.</div>
          )}
        </div>

        <div className="panel p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display font-semibold text-ink-100">Today's Trips</h2>
            <Link to="/portal/trips" className="text-xs text-amber-400 hover:underline">View all</Link>
          </div>
          {data.todaysTrips.length === 0 ? (
            <div className="text-sm text-ink-500">No trips recorded today.</div>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.todaysTrips.map((t) => (
                <li key={t.id} className="flex items-center justify-between border-b border-base-700 pb-2">
                  <span className="text-ink-200">{t.start_location} → {t.destination}</span>
                  <span className="font-mono text-ink-100">{t.total_km} km</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="panel p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display font-semibold text-ink-100">Recent Notifications</h2>
          <Link to="/portal/notifications" className="text-xs text-amber-400 hover:underline">View all</Link>
        </div>
        {data.notifications.length === 0 ? (
          <div className="text-sm text-ink-500">No notifications.</div>
        ) : (
          <ul className="space-y-2">
            {data.notifications.map((n) => (
              <li key={n.id} className={`text-sm border-l-2 pl-3 py-1 ${n.is_read ? "border-base-600" : "border-amber-400"}`}>
                <div className="text-ink-100">{n.title}</div>
                <div className="text-ink-400">{n.body}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
