import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";
import { Vehicle } from "../types";

export default function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [vehicleNumber, setVehicleNumber] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState<number>(2023);
  const [vehicleType, setVehicleType] = useState("Utility / Pickup");
  const [fuelType, setFuelType] = useState("Diesel");
  const [department, setDepartment] = useState("Operations");
  const [location, setLocation] = useState("Port Moresby (POM)");
  const [gpsImei, setGpsImei] = useState("");
  const [gpsDeviceType, setGpsDeviceType] = useState<"meshsat" | "teltonika">("meshsat");
  const [gpsDeviceModel, setGpsDeviceModel] = useState<"FMB125" | "FMC130" | "FMC650" | "FMB920" | "DUALCAM">("FMB125");
  const [gpsDeviceStatus, setGpsDeviceStatus] = useState<"active" | "inactive" | "maintenance">("active");

  const fetchVehicles = () => {
    api.get<{ data: Vehicle[] }>("/vehicles")
      .then((res) => setVehicles(res.data || []))
      .catch(() => setVehicles([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchVehicles();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setVehicleNumber("");
    setRegistrationNumber("");
    setMake("");
    setModel("");
    setYear(2023);
    setVehicleType("Utility / Pickup");
    setFuelType("Diesel");
    setDepartment("Operations");
    setLocation("Port Moresby (POM)");
    setGpsImei("");
    setGpsDeviceType("meshsat");
    setGpsDeviceModel("FMB125");
    setGpsDeviceStatus("active");
  };

  const handleOpenCreate = () => {
    resetForm();
    setShowModal(true);
  };

  const handleOpenEdit = (v: Vehicle) => {
    setEditingId(v.id);
    setVehicleNumber(v.vehicle_number || "");
    setRegistrationNumber(v.registration_number || "");
    setMake(v.make || "");
    setModel(v.model || "");
    setYear(v.year || 2023);
    setVehicleType(v.vehicle_type || "Utility / Pickup");
    setFuelType(v.fuel_type || "Diesel");
    setDepartment(v.department || "");
    setLocation(v.location || "");
    setGpsImei(v.gps_imei || "");
    setGpsDeviceType(v.gps_device_type || "meshsat");
    setGpsDeviceModel(v.gps_device_model || "FMB125");
    setGpsDeviceStatus(v.gps_device_status || "active");
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    resetForm();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        vehicleNumber,
        registrationNumber,
        make,
        model,
        year,
        vehicleType,
        fuelType,
        department,
        location,
        ...(editingId ? {} : { status: "active", ownership: "owned" }),
        gpsImei: gpsImei.trim(),
        gpsDeviceType,
        gpsDeviceModel,
        gpsDeviceStatus,
      };

      if (editingId) {
        await api.put(`/vehicles/${editingId}`, payload);
      } else {
        await api.post("/vehicles", payload);
      }
      handleCloseModal();
      fetchVehicles();
    } catch (err: any) {
      alert(err.message || `Failed to ${editingId ? "update" : "create"} vehicle`);
    }
  };

  const handleDelete = async (v: Vehicle) => {
    if (!window.confirm(`Delete vehicle "${v.vehicle_number}"?`)) return;
    try {
      await api.del(`/vehicles/${v.id}`);
      fetchVehicles();
    } catch (err: any) {
      alert(err.message || "Failed to delete vehicle");
    }
  };

  if (loading) return <div className="p-4 text-ink-400">Loading Vehicle Register…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink-100">Vehicle Master Register</h1>
          <p className="text-sm text-ink-400">Master record of all ground vehicles, pickups, and heavy fleet assets</p>
        </div>
        <button className="btn-primary" onClick={handleOpenCreate}>+ Register New Vehicle</button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-base-900 border-b border-base-700 text-ink-400 uppercase text-xs">
            <tr>
              <th className="px-4 py-3">Vehicle #</th>
              <th className="px-4 py-3">Reg #</th>
              <th className="px-4 py-3">GPS Tracking</th>
              <th className="px-4 py-3">Make & Model</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Fuel</th>
              <th className="px-4 py-3">Department</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800 text-ink-200">
            {Array.isArray(vehicles) && vehicles.map((v) => (
              <tr key={v.id} className="hover:bg-base-800/50">
                <td className="px-4 py-3 font-semibold text-amber-400">{v.vehicle_number}</td>
                <td className="px-4 py-3 font-mono">{v.registration_number}</td>
                <td className="px-4 py-3">
                  {v.gps_imei ? (
                    <div>
                      <div className="font-mono text-xs text-ink-200">{v.gps_imei}</div>
                      <div className="text-[10px] text-ink-500">
                        {[v.gps_device_model, v.gps_device_type, v.gps_device_status].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-ink-500">Not set</span>
                  )}
                </td>
                <td className="px-4 py-3">{v.make} {v.model} ({v.year})</td>
                <td className="px-4 py-3">{v.vehicle_type}</td>
                <td className="px-4 py-3">{v.fuel_type}</td>
                <td className="px-4 py-3">{v.department || "—"}</td>
                <td className="px-4 py-3">{v.location || "—"}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-xs rounded font-medium ${
                    v.status === "active" ? "bg-emerald-950 text-emerald-400 border border-emerald-800" :
                    v.status === "under_repair" ? "bg-amber-950 text-amber-400 border border-amber-800" :
                    "bg-base-800 text-ink-400"
                  }`}>
                    {v.status.replace("_", " ")}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button className="px-2 py-1 text-xs font-medium text-amber-400 hover:text-amber-300 hover:bg-base-800 rounded" onClick={() => handleOpenEdit(v)}>Edit</button>
                    <button className="px-2 py-1 text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-base-800 rounded" onClick={() => handleDelete(v)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {(!Array.isArray(vehicles) || vehicles.length === 0) && (
              <tr><td colSpan={10} className="px-4 py-6 text-center text-ink-500">No vehicles registered yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="panel p-6 max-w-2xl w-full space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-display font-semibold text-ink-100">{editingId ? "Edit Vehicle" : "Register Vehicle"}</h2>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Vehicle Number *</label>
                  <input className="input" value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} required placeholder="V005" disabled={Boolean(editingId)} />
                </div>
                <div>
                  <label className="label">Registration # *</label>
                  <input className="input" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} required placeholder="FLEET-005" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Make *</label>
                  <input className="input" value={make} onChange={(e) => setMake(e.target.value)} required placeholder="Toyota" />
                </div>
                <div>
                  <label className="label">Model *</label>
                  <input className="input" value={model} onChange={(e) => setModel(e.target.value)} required placeholder="Hilux" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Year</label>
                  <input className="input" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Vehicle Type</label>
                  <input className="input" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Department</label>
                  <input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} />
                </div>
                <div>
                  <label className="label">Location</label>
                  <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
                </div>
              </div>
              <div className="border-t border-base-700 pt-4 space-y-3">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-ink-300">GPS Tracking</h3>
                  <p className="text-[10px] text-ink-500 mt-1">
                    Bind this vehicle to its tracker. The IMEI must match the identifier used by telemetry ingest.
                    Leave it blank to unassign the current device.
                  </p>
                </div>
                <div>
                  <label className="label">GPS IMEI / Device ID</label>
                  <input
                    className="input font-mono"
                    value={gpsImei}
                    onChange={(e) => setGpsImei(e.target.value)}
                    placeholder="354018111234567"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="label">Device Type</label>
                    <select
                      className="input"
                      value={gpsDeviceType}
                      onChange={(e) => setGpsDeviceType(e.target.value as "meshsat" | "teltonika")}
                    >
                      <option value="meshsat">MeshSat</option>
                      <option value="teltonika">Teltonika</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Device Model</label>
                    <select
                      className="input"
                      value={gpsDeviceModel}
                      onChange={(e) => setGpsDeviceModel(e.target.value as "FMB125" | "FMC130" | "FMC650" | "FMB920" | "DUALCAM")}
                    >
                      <option value="FMB125">FMB125</option>
                      <option value="FMC130">FMC130</option>
                      <option value="FMC650">FMC650</option>
                      <option value="FMB920">FMB920</option>
                      <option value="DUALCAM">DUALCAM</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Device Status</label>
                    <select
                      className="input"
                      value={gpsDeviceStatus}
                      onChange={(e) => setGpsDeviceStatus(e.target.value as "active" | "inactive" | "maintenance")}
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="maintenance">Maintenance</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-3">
                <button type="button" className="btn-ghost" onClick={handleCloseModal}>Cancel</button>
                <button type="submit" className="btn-primary">{editingId ? "Update Vehicle" : "Save Vehicle"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
