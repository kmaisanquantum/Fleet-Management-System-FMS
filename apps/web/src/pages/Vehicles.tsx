import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { deviceConfigApi, type BulkConfigResult } from "../api/deviceConfig";
import { telemetryApi, type TelemetryLatest } from "../api/telemetry";
import { useAuth } from "../context/AuthContext";
import { Driver, Vehicle } from "../types";

const BULK_COMMAND_ROLES = new Set(["admin", "fleet_manager"]);

export default function Vehicles() {
  const { user } = useAuth();
  const canBulkConfigure = !!user && BULK_COMMAND_ROLES.has(user.role);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [latest, setLatest] = useState<Record<string, TelemetryLatest>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkPreset, setBulkPreset] = useState("reporting_interval");
  const [bulkValue, setBulkValue] = useState("30");
  const [bulkIgnitionOn, setBulkIgnitionOn] = useState("10");
  const [bulkIgnitionOff, setBulkIgnitionOff] = useState("60");
  const [bulkReason, setBulkReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkConfigResult[]>([]);
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
  const [assignedDriverId, setAssignedDriverId] = useState("");

  const fetchVehicles = () => {
    Promise.all([
      api.get<{ data: Vehicle[] }>("/vehicles"),
      api.get<{ data: Driver[] }>("/drivers"),
      telemetryApi.latest().catch(() => ({ data: [] as TelemetryLatest[] })),
    ])
      .then(([vehRes, drvRes, latestRes]) => {
        setVehicles(vehRes.data || []);
        setDrivers(drvRes.data || []);
        const byVehicle: Record<string, TelemetryLatest> = {};
        for (const row of latestRes.data || []) {
          if (row.imei) byVehicle[row.vehicle_id] = row;
        }
        setLatest(byVehicle);
      })
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
    setAssignedDriverId("");
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
    setAssignedDriverId(v.assigned_driver_id || "");
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

      let vehicleId = editingId;
      if (editingId) {
        await api.put(`/vehicles/${editingId}`, payload);
      } else {
        const created = await api.post<{ data: Vehicle }>("/vehicles", payload);
        vehicleId = created.data.id;
      }

      if (vehicleId) {
        const currentDriverId = editingId
          ? vehicles.find((v) => v.id === editingId)?.assigned_driver_id || ""
          : "";
        if (assignedDriverId !== currentDriverId) {
          await api.put(`/vehicles/${vehicleId}/driver`, {
            driverId: assignedDriverId || null,
          });
        }
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

  const devices = useMemo(
    () =>
      vehicles
        .map((vehicle) => ({ vehicle, device: latest[vehicle.id] }))
        .filter((row): row is { vehicle: Vehicle; device: TelemetryLatest } => Boolean(row.device?.imei)),
    [vehicles, latest]
  );
  const selectedImeis = selected
    .map((vehicleId) => latest[vehicleId]?.imei)
    .filter((imei): imei is string => Boolean(imei));
  const allSelected = devices.length > 0 && selectedImeis.length === devices.length;

  function toggleSelected(vehicleId: string) {
    setSelected((prev) =>
      prev.includes(vehicleId) ? prev.filter((id) => id !== vehicleId) : [...prev, vehicleId]
    );
  }

  function toggleAll() {
    setSelected(allSelected ? [] : devices.map((row) => row.vehicle.id));
  }

  async function applyBulkConfiguration() {
    if (selectedImeis.length === 0) {
      setBulkNotice("Select at least one device with an IMEI.");
      return;
    }
    const numericValue = Number(bulkValue);
    const ignitionOn = Number(bulkIgnitionOn);
    const ignitionOff = Number(bulkIgnitionOff);
    if (bulkPreset === "data_acquisition") {
      if (!Number.isFinite(ignitionOn) || ignitionOn < 0 || !Number.isFinite(ignitionOff) || ignitionOff < 0) {
        setBulkNotice("Enter valid non-negative ignition-on and ignition-off intervals.");
        return;
      }
    } else if (!Number.isFinite(numericValue) || numericValue < 0) {
      setBulkNotice("Enter a valid non-negative value.");
      return;
    } else if (bulkPreset === "digital_output_control" && numericValue !== 0 && numericValue !== 1) {
      setBulkNotice("Digital output must be 0 (off) or 1 (on).");
      return;
    }
    setBulkBusy(true);
    setBulkNotice(null);
    setBulkResults([]);
    try {
      const body: any = {
        imeis: selectedImeis,
        preset: bulkPreset,
        reason: bulkReason.trim() || undefined,
      };
      if (bulkPreset === "data_acquisition") {
        body.values = { ignition_on: ignitionOn, ignition_off: ignitionOff };
      } else {
        body.value = numericValue;
      }
      const res = await deviceConfigApi.bulkConfig(body);
      setBulkResults(res.data.results || []);
      setBulkNotice(res.message);
      setSelected([]);
      fetchVehicles();
    } catch (err: any) {
      setBulkNotice(err.message || "Failed to apply bulk configuration");
    } finally {
      setBulkBusy(false);
    }
  }

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

      {canBulkConfigure && (
        <div className="panel p-4 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-end gap-3">
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-ink-100">Bulk Device Configuration</h2>
              <p className="text-[11px] text-ink-500">
                Push a standard FMB125 profile to the selected vehicles. Offline devices queue until their next check-in.
              </p>
            </div>
            <div>
              <label className="label">Preset</label>
              <select
                className="input text-xs bg-base-900 border-base-700 text-ink-100"
                value={bulkPreset}
                onChange={(e) => setBulkPreset(e.target.value)}
              >
                <option value="reporting_interval">Reporting interval</option>
                <option value="data_acquisition">Data acquisition</option>
                <option value="ignition_source">Ignition source</option>
                <option value="digital_output_control">Digital output control</option>
              </select>
            </div>
            {bulkPreset === "data_acquisition" ? (
              <>
                <div>
                  <label className="label">Ignition ON (s)</label>
                  <input
                    className="input text-xs w-28 bg-base-900 border-base-700 text-ink-100"
                    type="number"
                    min={0}
                    value={bulkIgnitionOn}
                    onChange={(e) => setBulkIgnitionOn(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Ignition OFF (s)</label>
                  <input
                    className="input text-xs w-28 bg-base-900 border-base-700 text-ink-100"
                    type="number"
                    min={0}
                    value={bulkIgnitionOff}
                    onChange={(e) => setBulkIgnitionOff(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="label">Value</label>
                <input
                  className="input text-xs w-28 bg-base-900 border-base-700 text-ink-100"
                  type="number"
                  value={bulkValue}
                  onChange={(e) => setBulkValue(e.target.value)}
                />
              </div>
            )}
            <div>
              <label className="label">Reason</label>
              <input
                className="input text-xs w-48 bg-base-900 border-base-700 text-ink-100"
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
                placeholder="Change reference"
              />
            </div>
            <button
              onClick={() => void applyBulkConfiguration()}
              disabled={bulkBusy || selectedImeis.length === 0}
              className="btn-primary text-xs px-4 py-2 whitespace-nowrap"
            >
              Apply to {selectedImeis.length} device{selectedImeis.length === 1 ? "" : "s"}
            </button>
          </div>
          {bulkNotice && <div className="text-xs text-amber-300">{bulkNotice}</div>}
          {bulkResults.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {bulkResults.map((r) => (
                <div key={r.imei} className="p-2 rounded bg-base-950 border border-base-800 text-[11px]">
                  <span className="font-mono text-ink-200">{r.imei}</span>
                  <span className={`ml-2 pill ${r.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-signal-red/15 text-signal-red"}`}>
                    {r.status}
                  </span>
                  {r.error && <div className="text-signal-red mt-1">{r.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-base-900 border-b border-base-700 text-ink-400 uppercase text-xs">
            <tr>
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all devices"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={devices.length === 0}
                />
              </th>
              <th className="px-4 py-3">Vehicle #</th>
              <th className="px-4 py-3">Reg #</th>
              <th className="px-4 py-3">IMEI</th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Make & Model</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Fuel</th>
              <th className="px-4 py-3">Department</th>
              <th className="px-4 py-3">Assigned Driver</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800 text-ink-200">
            {Array.isArray(vehicles) && vehicles.map((v) => {
              const device = latest[v.id];
              const imei = device?.imei || v.gps_imei;
              return (
              <tr key={v.id} className="hover:bg-base-800/50">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${v.vehicle_number}`}
                    checked={selected.includes(v.id)}
                    onChange={() => toggleSelected(v.id)}
                    disabled={!device?.imei}
                  />
                </td>
                <td className="px-4 py-3 font-semibold">
                  <Link to={`/vehicles/${v.id}`} className="text-amber-400 hover:text-amber-300">
                    {v.vehicle_number}
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono">{v.registration_number}</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {imei ? (
                    <Link to={`/telemetry/device/${encodeURIComponent(imei)}?tab=configuration`} className="text-amber-400 hover:text-amber-300">
                      {imei}
                    </Link>
                  ) : (
                    <span className="text-ink-500">Unassigned</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {device ? (
                    <span className={`pill ${device.online ? "bg-emerald-500/15 text-emerald-400" : "bg-signal-red/15 text-signal-red"}`}>
                      {device.online ? "Online" : "Offline"}
                    </span>
                  ) : v.gps_device_model || v.gps_device_type ? (
                    <span className="text-[10px] text-ink-500">
                      {[v.gps_device_model, v.gps_device_type, v.gps_device_status].filter(Boolean).join(" · ")}
                    </span>
                  ) : (
                    <span className="text-xs text-ink-500">—</span>
                  )}
                </td>
                <td className="px-4 py-3">{v.make} {v.model} ({v.year})</td>
                <td className="px-4 py-3">{v.vehicle_type}</td>
                <td className="px-4 py-3">{v.fuel_type}</td>
                <td className="px-4 py-3">{v.department || "—"}</td>
                <td className="px-4 py-3">
                  {v.assigned_driver_id ? (
                    <Link to={`/drivers/${v.assigned_driver_id}`} className="text-amber-400 hover:text-amber-300">
                      {v.assigned_driver_name}
                      {v.assigned_driver_employee_number ? (
                        <span className="block text-[10px] text-ink-500">{v.assigned_driver_employee_number}</span>
                      ) : null}
                    </Link>
                  ) : (
                    <span className="text-xs text-ink-500">Unassigned</span>
                  )}
                </td>
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
                    {imei && (
                      <Link
                        to={`/device-configurator/${encodeURIComponent(imei)}`}
                        className="px-2 py-1 text-xs font-medium text-sky-400 hover:text-sky-300 hover:bg-base-800 rounded"
                      >
                        Configure
                      </Link>
                    )}
                    <button className="px-2 py-1 text-xs font-medium text-amber-400 hover:text-amber-300 hover:bg-base-800 rounded" onClick={() => handleOpenEdit(v)}>Edit</button>
                    <button className="px-2 py-1 text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-base-800 rounded" onClick={() => handleDelete(v)}>Delete</button>
                  </div>
                </td>
              </tr>
              );
            })}
            {(!Array.isArray(vehicles) || vehicles.length === 0) && (
              <tr><td colSpan={13} className="px-4 py-6 text-center text-ink-500">No vehicles registered yet.</td></tr>
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
              <div>
                <label className="label">Assigned Driver</label>
                <select className="input" value={assignedDriverId} onChange={(e) => setAssignedDriverId(e.target.value)}>
                  <option value="">Unassigned</option>
                  {drivers.map((d) => (
                    <option
                      key={d.id}
                      value={d.id}
                      disabled={d.authorisation_status !== "authorised" && d.id !== assignedDriverId}
                    >
                      {d.name} ({d.employee_number}){d.authorisation_status !== "authorised" ? " — not authorised" : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] text-ink-500">
                  Assigning a driver creates an active allocation and releases the vehicle&apos;s previous driver.
                </p>
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
