import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Vehicle, VehicleMaintenance } from "../types";

export default function VehicleMaintenancePage() {
  const [maintenanceRecords, setMaintenanceRecords] = useState<VehicleMaintenance[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [vehicleId, setVehicleId] = useState("");
  const [maintenanceType, setMaintenanceType] = useState<"scheduled_service" | "unscheduled_repair" | "inspection_fix" | "other">("scheduled_service");
  const [description, setDescription] = useState("");
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().slice(0, 10));
  const [technician, setTechnician] = useState("");
  const [cost, setCost] = useState<number | "">("");

  const fetchData = () => {
    Promise.all([
      api.get<{ data: VehicleMaintenance[] }>("/vehicle-maintenance/maintenance"),
      api.get<{ data: Vehicle[] }>("/vehicles"),
    ]).then(([maintRes, vehRes]) => {
      setMaintenanceRecords(maintRes.data || []);
      setVehicles(vehRes.data || []);
      if (vehRes.data && vehRes.data.length > 0) setVehicleId(vehRes.data[0].id);
    }).catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/vehicle-maintenance/maintenance", {
        vehicleId,
        maintenanceType,
        description,
        scheduledDate,
        technician,
        cost,
        status: "scheduled",
      });
      setShowModal(false);
      fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to schedule maintenance");
    }
  };

  if (loading) return <div className="p-4 text-ink-400">Loading Maintenance Records…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink-100">Vehicle Maintenance & Repairs</h1>
          <p className="text-sm text-ink-400">Scheduled vehicle services, workshop repair orders, breakdowns, and maintenance histories</p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>+ Schedule Maintenance</button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-base-900 border-b border-base-700 text-ink-400 uppercase text-xs">
            <tr>
              <th className="px-4 py-3">Vehicle #</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Description</th>
              <th className="px-4 py-3">Scheduled Date</th>
              <th className="px-4 py-3">Technician / Workshop</th>
              <th className="px-4 py-3">Cost (PGK)</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800 text-ink-200">
            {Array.isArray(maintenanceRecords) && maintenanceRecords.map((m) => (
              <tr key={m.id} className="hover:bg-base-800/50">
                <td className="px-4 py-3 font-semibold">
                  <Link to={`/vehicles/${m.vehicle_id}`} className="text-amber-400 hover:text-amber-300">
                    {m.vehicle_number}
                  </Link>
                </td>
                <td className="px-4 py-3">{m.maintenance_type.replace("_", " ")}</td>
                <td className="px-4 py-3">{m.description}</td>
                <td className="px-4 py-3">{m.scheduled_date || "—"}</td>
                <td className="px-4 py-3">{m.technician || "—"}</td>
                <td className="px-4 py-3 font-mono">{m.cost ? `K${m.cost.toFixed(2)}` : "—"}</td>
                <td className="px-4 py-3">
                  <span className="px-2 py-0.5 text-xs rounded font-medium bg-amber-950 text-amber-400 border border-amber-800">
                    {m.status.replace("_", " ")}
                  </span>
                </td>
              </tr>
            ))}
            {(!Array.isArray(maintenanceRecords) || maintenanceRecords.length === 0) && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-ink-500">No vehicle maintenance records logged.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="panel p-6 max-w-md w-full space-y-4">
            <h2 className="text-lg font-display font-semibold text-ink-100">Schedule Service / Repair</h2>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="label">Vehicle *</label>
                <select className="input" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>{v.vehicle_number} ({v.make} {v.model})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Type *</label>
                <select className="input" value={maintenanceType} onChange={(e) => setMaintenanceType(e.target.value as any)}>
                  <option value="scheduled_service">Scheduled Service</option>
                  <option value="unscheduled_repair">Unscheduled Repair</option>
                  <option value="inspection_fix">Inspection Fix</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="label">Description *</label>
                <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} required placeholder="Oil & filter change..." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Scheduled Date *</label>
                  <input className="input" type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} required />
                </div>
                <div>
                  <label className="label">Estimated Cost (PGK)</label>
                  <input className="input" type="number" value={cost} onChange={(e) => setCost(e.target.value === "" ? "" : Number(e.target.value))} />
                </div>
              </div>
              <div>
                <label className="label">Technician / Workshop</label>
                <input className="input" value={technician} onChange={(e) => setTechnician(e.target.value)} />
              </div>
              <div className="flex justify-end gap-3 pt-3">
                <button type="button" className="btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary">Save Maintenance</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
