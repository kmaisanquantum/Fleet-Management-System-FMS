import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Driver, Vehicle, VehicleFuelLog } from "../types";

export default function VehicleFuelLogs() {
  const [logs, setLogs] = useState<VehicleFuelLog[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [vehicleId, setVehicleId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState("");
  const [station, setStation] = useState("");
  const [fuelType, setFuelType] = useState("Diesel");
  const [litres, setLitres] = useState<number | "">("");
  const [costPerLitre, setCostPerLitre] = useState<number | "">("");
  const [odometerReading, setOdometerReading] = useState<number | "">("");
  const [paymentMethod, setPaymentMethod] = useState("");

  const fetchData = () => {
    Promise.all([
      api.get<{ data: VehicleFuelLog[] }>("/vehicle-fuel-logs"),
      api.get<{ data: Vehicle[] }>("/vehicles"),
      api.get<{ data: Driver[] }>("/drivers"),
    ]).then(([logsRes, vehRes, drvRes]) => {
      setLogs(logsRes.data || []);
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
      await api.post("/vehicle-fuel-logs", {
        vehicleId,
        driverId,
        date,
        time,
        station,
        fuelType,
        litres,
        costPerLitre,
        odometerReading,
        paymentMethod,
      });
      setShowModal(false);
      fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to log fuel entry");
    }
  };

  if (loading) return <div className="p-4 text-ink-400">Loading Vehicle Fuel Logs…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink-100">Vehicle Fuel Logs</h1>
          <p className="text-sm text-ink-400">Commercial ground vehicle refuelling logs and consumption efficiency metrics (L/100km)</p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>+ Log Vehicle Fuel</button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-base-900 border-b border-base-700 text-ink-400 uppercase text-xs">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Vehicle</th>
              <th className="px-4 py-3">Driver</th>
              <th className="px-4 py-3">Station</th>
              <th className="px-4 py-3">Litres</th>
              <th className="px-4 py-3">Cost / L</th>
              <th className="px-4 py-3">Total Cost</th>
              <th className="px-4 py-3">Odometer</th>
              <th className="px-4 py-3">L / 100km</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800 text-ink-200">
            {Array.isArray(logs) && logs.map((l) => (
              <tr key={l.id} className="hover:bg-base-800/50">
                <td className="px-4 py-3">{l.date}</td>
                <td className="px-4 py-3 font-semibold">
                  <Link to={`/vehicles/${l.vehicle_id}`} className="text-amber-400 hover:text-amber-300">
                    {l.vehicle_number}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  {l.driver_id ? (
                    <Link to={`/drivers/${l.driver_id}`} className="text-amber-400 hover:text-amber-300">
                      {l.driver_name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">{l.station || "—"}</td>
                <td className="px-4 py-3 font-mono">{l.litres} L</td>
                <td className="px-4 py-3 font-mono">K{l.cost_per_litre.toFixed(2)}</td>
                <td className="px-4 py-3 font-semibold text-ink-100">K{l.total_cost.toFixed(2)}</td>
                <td className="px-4 py-3 font-mono">{l.odometer_reading.toLocaleString()} km</td>
                <td className="px-4 py-3 font-mono text-amber-400">{l.l_per_100km ? `${l.l_per_100km} L` : "—"}</td>
              </tr>
            ))}
            {(!Array.isArray(logs) || logs.length === 0) && (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-ink-500">No vehicle fuel logs recorded.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="panel p-6 max-w-lg w-full space-y-4">
            <h2 className="text-lg font-display font-semibold text-ink-100">Log Vehicle Fuel</h2>
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Vehicle *</label>
                  <select className="input" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>{v.vehicle_number} ({v.make} {v.model})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Driver</label>
                  <select className="input" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                    {drivers.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Date *</label>
                  <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
                </div>
                <div>
                  <label className="label">Station Name</label>
                  <input className="input" value={station} onChange={(e) => setStation(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Litres *</label>
                  <input className="input" type="number" step="0.1" value={litres} onChange={(e) => setLitres(e.target.value === "" ? "" : Number(e.target.value))} required />
                </div>
                <div>
                  <label className="label">Cost/L (PGK) *</label>
                  <input className="input" type="number" step="0.01" value={costPerLitre} onChange={(e) => setCostPerLitre(e.target.value === "" ? "" : Number(e.target.value))} required />
                </div>
                <div>
                  <label className="label">Odometer (km) *</label>
                  <input className="input" type="number" value={odometerReading} onChange={(e) => setOdometerReading(e.target.value === "" ? "" : Number(e.target.value))} required />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-3">
                <button type="button" className="btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary">Save Fuel Entry</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
