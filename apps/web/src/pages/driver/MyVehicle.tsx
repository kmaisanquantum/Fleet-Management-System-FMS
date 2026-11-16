import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { AssignedVehicleInfo } from "../../types";
import { PageHeader, StatusBadge } from "./shared";

export default function MyVehicle() {
  const [vehicle, setVehicle] = useState<AssignedVehicleInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ data: AssignedVehicleInfo | null }>("/driver-portal/vehicle")
      .then((res) => setVehicle(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-ink-400">Loading vehicle…</div>;
  if (!vehicle) return <div className="panel p-6 text-ink-400">No vehicle is currently assigned to you.</div>;

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Vehicle Number", value: <span className="text-amber-400 font-semibold">{vehicle.vehicle_number}</span> },
    { label: "Registration", value: vehicle.registration_number },
    { label: "Make / Model", value: `${vehicle.make} ${vehicle.model}` },
    { label: "Type", value: vehicle.vehicle_type },
    { label: "Fuel Type", value: vehicle.fuel_type },
    { label: "Department", value: vehicle.department ?? "—" },
    { label: "Location", value: vehicle.location ?? "—" },
    { label: "Status", value: <StatusBadge value={vehicle.status} /> },
    { label: "Current Odometer", value: `${vehicle.current_odometer.toLocaleString()} km` },
    { label: "Tank Capacity", value: vehicle.tank_capacity_litres ? `${vehicle.tank_capacity_litres} L` : "—" },
    { label: "Expected Economy", value: vehicle.expected_km_per_l ? `${vehicle.expected_km_per_l} km/L` : "—" },
    { label: "Allocated On", value: vehicle.allocation_date },
    { label: "Return Date", value: vehicle.return_date ?? "Open-ended" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="My Assigned Vehicle" subtitle="Details of the vehicle currently allocated to you" />
      {vehicle.blockReason && (
        <div className="panel p-4 border-signal-red/60 bg-red-950/30 text-sm text-signal-red">{vehicle.blockReason}</div>
      )}
      <div className="panel divide-y divide-base-700">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 px-5 py-3">
            <div className="text-xs uppercase tracking-wide text-ink-500">{r.label}</div>
            <div className="text-sm text-ink-100">{r.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
