import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Driver, Vehicle, VehicleTrip } from "../types";

export default function VehicleTrips() {
  const [trips, setTrips] = useState<VehicleTrip[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [vehicleId, setVehicleId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [timeOut, setTimeOut] = useState("");
  const [timeIn, setTimeIn] = useState("");
  const [startLocation, setStartLocation] = useState("");
  const [destination, setDestination] = useState("");
  const [purpose, setPurpose] = useState("");
  const [beginOdometer, setBeginOdometer] = useState<number | "">("");
  const [endOdometer, setEndOdometer] = useState<number | "">("");
  const [authorisingOfficer, setAuthorisingOfficer] = useState("");

  const fetchData = () => {
    Promise.all([
      api.get<{ data: VehicleTrip[] }>("/vehicle-trips"),
      api.get<{ data: Vehicle[] }>("/vehicles"),
      api.get<{ data: Driver[] }>("/drivers"),
    ]).then(([tripsRes, vehRes, drvRes]) => {
      setTrips(tripsRes.data || []);
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
      await api.post("/vehicle-trips", {
        vehicleId,
        driverId,
        date,
        timeOut,
        timeIn,
        startLocation,
        destination,
        purpose,
        beginOdometer,
        endOdometer,
        authorisingOfficer,
      });
      setShowModal(false);
      fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to log trip");
    }
  };

  if (loading) return <div className="p-4 text-ink-400">Loading Vehicle Trips…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-semibold text-ink-100">Mileage & Trip Logs</h1>
          <p className="text-sm text-ink-400">Vehicle movement, start/end odometer tracking, distance calculations, and anomaly detection</p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>+ Log Trip</button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-base-900 border-b border-base-700 text-ink-400 uppercase text-xs">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Vehicle</th>
              <th className="px-4 py-3">Driver</th>
              <th className="px-4 py-3">Route</th>
              <th className="px-4 py-3">Purpose</th>
              <th className="px-4 py-3">Begin Odometer</th>
              <th className="px-4 py-3">End Odometer</th>
              <th className="px-4 py-3">Total Km</th>
              <th className="px-4 py-3">Anomaly</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800 text-ink-200">
            {Array.isArray(trips) && trips.map((t) => (
              <tr key={t.id} className="hover:bg-base-800/50">
                <td className="px-4 py-3">{t.date}</td>
                <td className="px-4 py-3 font-semibold">
                  <Link to={`/vehicles/${t.vehicle_id}`} className="text-amber-400 hover:text-amber-300">
                    {t.vehicle_number}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  {t.driver_id ? (
                    <Link to={`/drivers/${t.driver_id}`} className="text-amber-400 hover:text-amber-300">
                      {t.driver_name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">{t.start_location} → {t.destination}</td>
                <td className="px-4 py-3">{t.purpose || "—"}</td>
                <td className="px-4 py-3 font-mono">{t.begin_odometer.toLocaleString()}</td>
                <td className="px-4 py-3 font-mono">{t.end_odometer.toLocaleString()}</td>
                <td className="px-4 py-3 font-semibold text-ink-100">{t.total_km} km</td>
                <td className="px-4 py-3">
                  {t.odometer_anomaly === 1 ? (
                    <span className="px-2 py-0.5 text-xs rounded font-medium bg-red-950 text-red-400 border border-red-800">
                      FLAGGED
                    </span>
                  ) : (
                    <span className="text-ink-500">Normal</span>
                  )}
                </td>
              </tr>
            ))}
            {(!Array.isArray(trips) || trips.length === 0) && (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-ink-500">No vehicle trips logged.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="panel p-6 max-w-lg w-full space-y-4">
            <h2 className="text-lg font-display font-semibold text-ink-100">Log Vehicle Trip</h2>
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
                  <label className="label">Start Location *</label>
                  <input className="input" value={startLocation} onChange={(e) => setStartLocation(e.target.value)} required />
                </div>
                <div>
                  <label className="label">Destination *</label>
                  <input className="input" value={destination} onChange={(e) => setDestination(e.target.value)} required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Begin Odometer *</label>
                  <input className="input" type="number" value={beginOdometer} onChange={(e) => setBeginOdometer(e.target.value === "" ? "" : Number(e.target.value))} required />
                </div>
                <div>
                  <label className="label">End Odometer *</label>
                  <input className="input" type="number" value={endOdometer} onChange={(e) => setEndOdometer(e.target.value === "" ? "" : Number(e.target.value))} required />
                </div>
              </div>
              <div>
                <label className="label">Purpose</label>
                <input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              </div>
              <div className="flex justify-end gap-3 pt-3">
                <button type="button" className="btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary">Save Trip</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
