import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Driver, Vehicle, VehicleAllocation } from "../types";

export default function VehicleAllocations() {
  const [allocations, setAllocations] = useState<VehicleAllocation[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [vehicleId, setVehicleId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [department, setDepartment] = useState("Operations");
  const [custodian, setCustodian] = useState("");
  const [allocationDate, setAllocationDate] = useState(new Date().toISOString().slice(0, 10));

  const fetchData = () => {
    Promise.all([
      api.get<{ data: VehicleAllocation[] }>("/vehicle-allocations"),
      api.get<{ data: Vehicle[] }>("/vehicles"),
      api.get<{ data: Driver[] }>("/drivers"),
    ]).then(([allocRes, vehRes, drvRes]) => {
      setAllocations(allocRes.data || []);
      setVehicles(vehRes.data || []);
      setDrivers(drvRes.data || []);
      if (vehRes.data && vehRes.data.length > 0) setVehicleId(vehRes.data[0].id);
      if (drvRes.data && drvRes.data.length > 0) setDriverId(drvRes.data[0].id);
    }).catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/vehicle-allocations", {
        vehicleId,
        driverId,
        department,
        custodian,
        allocationDate,
        approvalStatus: "approved",
        authorisationStatus: "active",
      });
      setShowModal(false);
      fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to create allocation");
    }
  };

  if (loading) return <div className="p-4 text-ink-400">Loading Allocations…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink-100">Vehicle Allocations</h1>
          <p className="text-sm text-ink-400">Departmental vehicle allocations, custodianship, and driver assignments</p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>+ New Allocation</button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-base-900 border-b border-base-700 text-ink-400 uppercase text-xs">
            <tr>
              <th className="px-4 py-3">Vehicle</th>
              <th className="px-4 py-3">Department</th>
              <th className="px-4 py-3">Custodian</th>
              <th className="px-4 py-3">Assigned Driver</th>
              <th className="px-4 py-3">Allocated Date</th>
              <th className="px-4 py-3">Allocation Status</th>
              <th className="px-4 py-3">Approval Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800 text-ink-200">
            {Array.isArray(allocations) && allocations.map((a) => (
              <tr key={a.id} className="hover:bg-base-800/50">
                <td className="px-4 py-3 font-semibold">
                  <Link to={`/vehicles/${a.vehicle_id}`} className="text-amber-400 hover:text-amber-300">
                    {a.vehicle_number}
                  </Link>
                </td>
                <td className="px-4 py-3">{a.department || "—"}</td>
                <td className="px-4 py-3">{a.custodian || "—"}</td>
                <td className="px-4 py-3">
                  {a.driver_id ? (
                    <Link to={`/drivers/${a.driver_id}`} className="text-amber-400 hover:text-amber-300">
                      {a.driver_name}
                    </Link>
                  ) : (
                    "Unassigned"
                  )}
                </td>
                <td className="px-4 py-3">{a.allocation_date}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-xs rounded font-medium border ${
                    a.authorisation_status === "active"
                      ? "bg-emerald-950 text-emerald-400 border-emerald-800"
                      : "bg-base-800 text-ink-400 border-base-700"
                  }`}>
                    {a.authorisation_status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="px-2 py-0.5 text-xs rounded font-medium bg-emerald-950 text-emerald-400 border border-emerald-800">
                    {a.approval_status}
                  </span>
                </td>
              </tr>
            ))}
            {(!Array.isArray(allocations) || allocations.length === 0) && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-ink-500">No vehicle allocations recorded.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="panel p-6 max-w-md w-full space-y-4">
            <h2 className="text-lg font-display font-semibold text-ink-100">Create Allocation</h2>
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
                <label className="label">Assigned Driver</label>
                <select className="input" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>{d.name} ({d.employee_number})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Department</label>
                <input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} />
              </div>
              <div>
                <label className="label">Custodian Name</label>
                <input className="input" value={custodian} onChange={(e) => setCustodian(e.target.value)} placeholder="Custodian" />
              </div>
              <div>
                <label className="label">Allocation Date *</label>
                <input className="input" type="date" value={allocationDate} onChange={(e) => setAllocationDate(e.target.value)} required />
              </div>
              <div className="flex justify-end gap-3 pt-3">
                <button type="button" className="btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary">Save Allocation</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
