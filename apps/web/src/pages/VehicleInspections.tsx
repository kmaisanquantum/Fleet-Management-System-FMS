import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Vehicle, VehicleInspection } from "../types";

export default function VehicleInspections() {
  const [inspections, setInspections] = useState<VehicleInspection[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [vehicleId, setVehicleId] = useState("");
  const [inspectorName, setInspectorName] = useState("");
  const [inspectionDate, setInspectionDate] = useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<"pass" | "fail" | "requires_attention">("pass");
  const [notes, setNotes] = useState("");

  const fetchData = () => {
    Promise.all([
      api.get<{ data: VehicleInspection[] }>("/vehicle-inspections"),
      api.get<{ data: Vehicle[] }>("/vehicles"),
    ]).then(([inspRes, vehRes]) => {
      setInspections(inspRes.data || []);
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
      await api.post("/vehicle-inspections", {
        vehicleId,
        inspectorName,
        inspectionDate,
        result,
        checklist: {
          tires: "pass",
          brakes: "pass",
          lights: "pass",
          fluid_levels: "pass",
          safety_equipment: "pass",
        },
        notes,
      });
      setShowModal(false);
      fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to record inspection");
    }
  };

  if (loading) return <div className="p-4 text-ink-400">Loading Inspections…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink-100">Daily Vehicle Inspections</h1>
          <p className="text-sm text-ink-400">Pre-operation safety checklists, pass/fail status, and critical failure alert triggers</p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>+ New Inspection</button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-base-900 border-b border-base-700 text-ink-400 uppercase text-xs">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Vehicle #</th>
              <th className="px-4 py-3">Inspector</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800 text-ink-200">
            {Array.isArray(inspections) && inspections.map((i) => (
              <tr key={i.id} className="hover:bg-base-800/50">
                <td className="px-4 py-3">{i.inspection_date}</td>
                <td className="px-4 py-3 font-semibold">
                  <Link to={`/vehicles/${i.vehicle_id}`} className="text-amber-400 hover:text-amber-300">
                    {i.vehicle_number}
                  </Link>
                </td>
                <td className="px-4 py-3">{i.inspector_name}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-xs rounded font-medium ${
                    i.result === "pass" ? "bg-emerald-950 text-emerald-400 border border-emerald-800" :
                    i.result === "fail" ? "bg-red-950 text-red-400 border border-red-800" :
                    "bg-amber-950 text-amber-400 border border-amber-800"
                  }`}>
                    {i.result.replace("_", " ").toUpperCase()}
                  </span>
                </td>
                <td className="px-4 py-3 text-ink-400">{i.notes || "—"}</td>
              </tr>
            ))}
            {(!Array.isArray(inspections) || inspections.length === 0) && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-ink-500">No vehicle inspections recorded.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="panel p-6 max-w-md w-full space-y-4">
            <h2 className="text-lg font-display font-semibold text-ink-100">Perform Daily Inspection</h2>
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
                <label className="label">Inspector Name *</label>
                <input className="input" value={inspectorName} onChange={(e) => setInspectorName(e.target.value)} required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Date *</label>
                  <input className="input" type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} required />
                </div>
                <div>
                  <label className="label">Result *</label>
                  <select className="input" value={result} onChange={(e) => setResult(e.target.value as any)}>
                    <option value="pass">PASS</option>
                    <option value="requires_attention">REQUIRES ATTENTION</option>
                    <option value="fail">FAIL (Trigger Critical Alert)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Notes / Defects</label>
                <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Inspection comments..." />
              </div>
              <div className="flex justify-end gap-3 pt-3">
                <button type="button" className="btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary">Submit Inspection</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
