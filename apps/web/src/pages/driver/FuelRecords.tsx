import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { VehicleFuelLog } from "../../types";
import StatCard from "../../components/StatCard";
import { EmptyState, Field, Modal, PageHeader, PhotoUpload, StatusBadge } from "./shared";

interface FuelResponse {
  data: (VehicleFuelLog & { receipt_url?: string | null; reconciliation_status?: string })[];
  summary: { totalLitres: number; totalCost: number };
}

export default function FuelRecords() {
  const [logs, setLogs] = useState<FuelResponse["data"]>([]);
  const [summary, setSummary] = useState({ totalLitres: 0, totalCost: 0 });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [station, setStation] = useState("");
  const [fuelType, setFuelType] = useState("Diesel");
  const [litres, setLitres] = useState<number | "">("");
  const [costPerLitre, setCostPerLitre] = useState<number | "">("");
  const [odometerReading, setOdometerReading] = useState<number | "">("");
  const [receiptRef, setReceiptRef] = useState("");
  const [receipt, setReceipt] = useState<string[]>([]);

  function load() {
    api
      .get<FuelResponse>("/driver-portal/fuel")
      .then((res) => {
        setLogs(res.data || []);
        setSummary(res.summary);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/driver-portal/fuel", {
        station,
        fuelType,
        litres,
        costPerLitre,
        odometerReading,
        receiptRef: receiptRef || undefined,
        receiptUrl: receipt[0],
      });
      setShowForm(false);
      setStation("");
      setLitres("");
      setCostPerLitre("");
      setOdometerReading("");
      setReceiptRef("");
      setReceipt([]);
      load();
    } catch (err: any) {
      setError(err.message || "Failed to log fuel");
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading fuel records…</div>;

  const estimatedTotal = litres !== "" && costPerLitre !== "" ? (Number(litres) * Number(costPerLitre)).toFixed(2) : "—";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fuel Records"
        subtitle="Your refuelling entries — verified by fleet administration"
        action={<button className="btn-primary" onClick={() => setShowForm(true)}>Log Fuel</button>}
      />

      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Total Fuel" value={`${summary.totalLitres.toLocaleString()} L`} />
        <StatCard label="Total Cost" value={summary.totalCost.toLocaleString()} />
      </div>

      <div className="panel overflow-x-auto">
        <table className="table-shell">
          <thead>
            <tr>
              <th>Date</th>
              <th>Station</th>
              <th>Fuel</th>
              <th>Litres</th>
              <th>Cost</th>
              <th>Odometer</th>
              <th>Verification</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{l.date}</td>
                <td>{l.station || "—"}</td>
                <td>{l.fuel_type}</td>
                <td className="font-mono">{l.litres}</td>
                <td className="font-mono">{l.total_cost.toLocaleString()}</td>
                <td className="font-mono">{l.odometer_reading.toLocaleString()}</td>
                <td><StatusBadge value={l.reconciliation_status} /></td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={7}><EmptyState>No fuel records yet.</EmptyState></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <Modal title="Log Fuel" onClose={() => setShowForm(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <Field label="Station *" value={station} onChange={(e) => setStation(e.target.value)} required />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Fuel Type *</label>
                <select className="input" value={fuelType} onChange={(e) => setFuelType(e.target.value)}>
                  <option>Diesel</option>
                  <option>Petrol</option>
                  <option>Other</option>
                </select>
              </div>
              <Field
                label="Litres *"
                type="number"
                step="0.01"
                value={litres}
                onChange={(e) => setLitres(e.target.value === "" ? "" : Number(e.target.value))}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Cost / Litre *"
                type="number"
                step="0.01"
                value={costPerLitre}
                onChange={(e) => setCostPerLitre(e.target.value === "" ? "" : Number(e.target.value))}
                required
              />
              <Field
                label="Odometer (km) *"
                type="number"
                value={odometerReading}
                onChange={(e) => setOdometerReading(e.target.value === "" ? "" : Number(e.target.value))}
                required
              />
            </div>
            <div className="text-sm text-ink-300">Total: <span className="font-mono">{estimatedTotal}</span></div>
            <Field label="Receipt Number" value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} />
            <PhotoUpload label="Receipt Photo" value={receipt} onChange={setReceipt} multiple={false} capture />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn-primary">Save Fuel Log</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
