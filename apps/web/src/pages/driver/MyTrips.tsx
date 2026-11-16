import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { VehicleTrip } from "../../types";
import { EmptyState, Field, Modal, PageHeader } from "./shared";

interface TripsResponse {
  data: VehicleTrip[];
  activeTrip: VehicleTrip | null;
  summary: { totalTrips: number; totalKm: number };
}

export default function MyTrips() {
  const [trips, setTrips] = useState<VehicleTrip[]>([]);
  const [active, setActive] = useState<VehicleTrip | null>(null);
  const [summary, setSummary] = useState({ totalTrips: 0, totalKm: 0 });
  const [loading, setLoading] = useState(true);
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [startLocation, setStartLocation] = useState("");
  const [destination, setDestination] = useState("");
  const [purpose, setPurpose] = useState("");
  const [beginOdometer, setBeginOdometer] = useState<number | "">("");
  const [endOdometer, setEndOdometer] = useState<number | "">("");

  function load() {
    api
      .get<TripsResponse>("/driver-portal/trips")
      .then((res) => {
        setTrips(res.data || []);
        setActive(res.activeTrip);
        setSummary(res.summary);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleStart(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/driver-portal/trips/start", { startLocation, destination, purpose, beginOdometer });
      setShowStart(false);
      setStartLocation("");
      setDestination("");
      setPurpose("");
      setBeginOdometer("");
      load();
    } catch (err: any) {
      setError(err.message || "Failed to start trip");
    }
  }

  async function handleEnd(e: FormEvent) {
    e.preventDefault();
    if (!active) return;
    setError(null);
    try {
      await api.post(`/driver-portal/trips/${active.id}/end`, { endOdometer });
      setShowEnd(false);
      setEndOdometer("");
      load();
    } catch (err: any) {
      setError(err.message || "Failed to end trip");
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading trips…</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Trips"
        subtitle={`${summary.totalTrips} trips · ${summary.totalKm.toLocaleString()} km total`}
        action={
          active ? (
            <button className="btn-primary" onClick={() => setShowEnd(true)}>End Active Trip</button>
          ) : (
            <button className="btn-primary" onClick={() => setShowStart(true)}>Start Trip</button>
          )
        }
      />

      {active && (
        <div className="panel p-4 border-amber-400/60">
          <div className="text-xs uppercase tracking-wide text-ink-500">Trip in progress</div>
          <div className="text-sm text-ink-100 mt-1">{active.start_location} → {active.destination} · began {active.time_out}</div>
        </div>
      )}

      <div className="panel overflow-x-auto">
        <table className="table-shell">
          <thead>
            <tr>
              <th>Date</th>
              <th>Vehicle</th>
              <th>Route</th>
              <th>Purpose</th>
              <th>Begin</th>
              <th>End</th>
              <th>Km</th>
            </tr>
          </thead>
          <tbody>
            {trips.map((t) => (
              <tr key={t.id}>
                <td>{t.date}</td>
                <td className="text-amber-400">{t.vehicle_number}</td>
                <td>{t.start_location} → {t.destination}</td>
                <td>{t.purpose || "—"}</td>
                <td className="font-mono">{t.begin_odometer.toLocaleString()}</td>
                <td className="font-mono">{t.end_odometer.toLocaleString()}</td>
                <td className="font-semibold">{t.total_km} km</td>
              </tr>
            ))}
            {trips.length === 0 && (
              <tr><td colSpan={7}><EmptyState>No trips recorded yet.</EmptyState></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showStart && (
        <Modal title="Start Trip" onClose={() => setShowStart(false)}>
          <form onSubmit={handleStart} className="space-y-3">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <Field label="Start Location *" value={startLocation} onChange={(e) => setStartLocation(e.target.value)} required />
            <Field label="Destination *" value={destination} onChange={(e) => setDestination(e.target.value)} required />
            <Field label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
            <Field
              label="Begin Odometer (km) *"
              type="number"
              value={beginOdometer}
              onChange={(e) => setBeginOdometer(e.target.value === "" ? "" : Number(e.target.value))}
              required
            />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setShowStart(false)}>Cancel</button>
              <button type="submit" className="btn-primary">Start</button>
            </div>
          </form>
        </Modal>
      )}

      {showEnd && active && (
        <Modal title="End Trip" onClose={() => setShowEnd(false)}>
          <form onSubmit={handleEnd} className="space-y-3">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <div className="text-sm text-ink-300">{active.start_location} → {active.destination}</div>
            <Field
              label="End Odometer (km) *"
              type="number"
              value={endOdometer}
              onChange={(e) => setEndOdometer(e.target.value === "" ? "" : Number(e.target.value))}
              required
            />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setShowEnd(false)}>Cancel</button>
              <button type="submit" className="btn-primary">End Trip</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
