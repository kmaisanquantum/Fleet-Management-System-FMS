import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";

interface FuelTxn {
  id: string;
  vehicle_id: string;
  vehicle_number: string;
  registration_number: string;
  driver_name?: string;
  date: string;
  time?: string;
  station_name?: string;
  fuel_type: string;
  litres: number;
  cost_per_litre: number;
  total_cost: number;
  odometer_reading: number;
  km_per_l?: number;
  l_per_100km?: number;
  cost_per_km?: number;
  card_number?: string;
  source: string;
  gps_verified: number;
  reconciliation_status: "verified" | "exception" | "pending";
}

export default function FuelIntelligence() {
  const [transactions, setTransactions] = useState<FuelTxn[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [stations, setStations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");

  // Record modal
  const [showModal, setShowModal] = useState(false);
  const [formVehicles, setFormVehicles] = useState<any[]>([]);
  const [formDrivers, setFormDrivers] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [vehicleId, setVehicleId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [fuelCardId, setFuelCardId] = useState("");
  const [stationId, setStationId] = useState("");
  const [stationName, setStationName] = useState("");
  const [date, setDate] = useState(new Date().toISOString().substring(0, 10));
  const [time, setTime] = useState("10:00");
  const [fuelType, setFuelType] = useState("Diesel");
  const [litres, setLitres] = useState(60);
  const [costPerLitre, setCostPerLitre] = useState(3.80);
  const [odometer, setOdometer] = useState(45300);
  const [source, setSource] = useState<"card" | "depot" | "manual">("card");

  useEffect(() => {
    loadData();
  }, [statusFilter, sourceFilter]);

  async function loadData() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.append("reconciliationStatus", statusFilter);
      if (sourceFilter !== "all") params.append("source", sourceFilter);

      const [txRes, cardRes, stnRes, vRes, dRes] = await Promise.all([
        apiGet<{ data: FuelTxn[] }>(`/fuel-transactions?${params.toString()}`),
        apiGet<{ data: any[] }>("/fuel-transactions/cards"),
        apiGet<{ data: any[] }>("/fuel-transactions/stations"),
        apiGet<{ data: any[] }>("/vehicles"),
        apiGet<{ data: any[] }>("/drivers"),
      ]);

      setTransactions(txRes.data);
      setCards(cardRes.data);
      setStations(stnRes.data);
      setFormVehicles(vRes.data);
      setFormDrivers(dRes.data);
    } catch (err) {
      console.error("Failed to load fuel transactions:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await apiPost<{ data: any; reconciliation: any }>("/fuel-transactions", {
        vehicleId,
        driverId: driverId || undefined,
        fuelCardId: fuelCardId || undefined,
        stationId: stationId || undefined,
        station: stationName || undefined,
        date,
        time,
        fuelType,
        litres: Number(litres),
        costPerLitre: Number(costPerLitre),
        odometerReading: Number(odometer),
        source,
      });

      setShowModal(false);
      alert(`Transaction logged. Reconciliation Status: ${res.reconciliation.status.toUpperCase()}`);
      loadData();
    } catch (err: any) {
      alert(err.message || "Failed to record transaction");
    } finally {
      setSubmitting(false);
    }
  }

  const verifiedCount = transactions.filter((t) => t.reconciliation_status === "verified").length;
  const exceptionCount = transactions.filter((t) => t.reconciliation_status === "exception").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Fuel Intelligence & Reconciliation</h1>
          <p className="text-sm text-ink-400">Automated card-to-GPS location matching, tank capacity checks, and efficiency tracking</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="btn-amber text-sm font-medium px-4 py-2 rounded-lg"
        >
          + Ingest Fuel Transaction
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-base-900 border border-base-700 rounded-xl p-4">
          <div className="text-xs font-semibold text-ink-500 uppercase">Total Transactions</div>
          <div className="text-2xl font-bold text-ink-100 mt-1">{transactions.length}</div>
        </div>

        <div className="bg-base-900 border border-emerald-500/30 rounded-xl p-4">
          <div className="text-xs font-semibold text-emerald-400 uppercase">GPS Verified</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{verifiedCount}</div>
        </div>

        <div className="bg-base-900 border border-red-500/30 rounded-xl p-4">
          <div className="text-xs font-semibold text-red-400 uppercase">Exceptions Flagged</div>
          <div className="text-2xl font-bold text-red-400 mt-1">{exceptionCount}</div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-base-900 border border-base-700 rounded-xl p-4 flex flex-wrap gap-4 items-center justify-between">
        <div className="flex gap-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="input text-xs bg-base-950 border-base-700 text-ink-100"
          >
            <option value="all">All Statuses</option>
            <option value="verified">Verified</option>
            <option value="exception">Exception</option>
            <option value="pending">Pending</option>
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="input text-xs bg-base-950 border-base-700 text-ink-100"
          >
            <option value="all">All Sources</option>
            <option value="card">Fuel Card</option>
            <option value="depot">Depot Direct</option>
            <option value="manual">Manual Entry</option>
          </select>
        </div>
      </div>

      {/* Transactions Table */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-ink-400">Loading transactions…</div>
        ) : (
          <table className="w-full text-left text-xs text-ink-200">
            <thead className="bg-base-950 text-ink-400 border-b border-base-700 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Date/Time</th>
                <th className="px-4 py-3">Vehicle</th>
                <th className="px-4 py-3">Driver</th>
                <th className="px-4 py-3">Station / Depot</th>
                <th className="px-4 py-3">Litres</th>
                <th className="px-4 py-3">Total Cost</th>
                <th className="px-4 py-3">Efficiency</th>
                <th className="px-4 py-3">Reconciliation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-800">
              {transactions.map((t) => (
                <tr key={t.id} className="hover:bg-base-800/40">
                  <td className="px-4 py-3 whitespace-nowrap font-mono">{t.date} {t.time || ""}</td>
                  <td className="px-4 py-3 whitespace-nowrap font-semibold text-ink-100">{t.vehicle_number}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{t.driver_name || "Unassigned"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{t.station_name || "N/A"}</td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono">{t.litres} L</td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono">K {t.total_cost}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{t.km_per_l ? `${t.km_per_l} km/L` : "N/A"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      t.reconciliation_status === "verified"
                        ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                        : "bg-red-500/20 text-red-400 border border-red-500/40"
                    }`}>
                      {t.reconciliation_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Record Transaction Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-base-900 border border-base-700 rounded-xl p-6 w-full max-w-lg space-y-4">
            <h2 className="text-lg font-bold text-ink-100">Ingest Fuel Transaction</h2>
            <form onSubmit={handleSubmit} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-ink-300 mb-1">Vehicle</label>
                  <select
                    required
                    value={vehicleId}
                    onChange={(e) => setVehicleId(e.target.value)}
                    className="input w-full bg-base-950 border-base-700 text-ink-100"
                  >
                    <option value="">Select Vehicle</option>
                    {formVehicles.map((v) => (
                      <option key={v.id} value={v.id}>{v.vehicle_number} ({v.registration_number})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-ink-300 mb-1">Driver</label>
                  <select
                    value={driverId}
                    onChange={(e) => setDriverId(e.target.value)}
                    className="input w-full bg-base-950 border-base-700 text-ink-100"
                  >
                    <option value="">Select Driver</option>
                    {formDrivers.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-ink-300 mb-1">Station / Depot</label>
                  <select
                    value={stationId}
                    onChange={(e) => {
                      setStationId(e.target.value);
                      const st = stations.find((s) => s.id === e.target.value);
                      if (st) setStationName(st.name);
                    }}
                    className="input w-full bg-base-950 border-base-700 text-ink-100"
                  >
                    <option value="">Select Station</option>
                    {stations.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-ink-300 mb-1">Source</label>
                  <select
                    value={source}
                    onChange={(e: any) => setSource(e.target.value)}
                    className="input w-full bg-base-950 border-base-700 text-ink-100"
                  >
                    <option value="card">Fuel Card</option>
                    <option value="depot">Depot Direct</option>
                    <option value="manual">Manual Entry</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-ink-300 mb-1">Litres</label>
                  <input
                    type="number"
                    step="0.1"
                    required
                    value={litres}
                    onChange={(e) => setLitres(Number(e.target.value))}
                    className="input w-full bg-base-950 border-base-700 text-ink-100"
                  />
                </div>

                <div>
                  <label className="block text-ink-300 mb-1">Cost Per Litre (K)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={costPerLitre}
                    onChange={(e) => setCostPerLitre(Number(e.target.value))}
                    className="input w-full bg-base-950 border-base-700 text-ink-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-ink-300 mb-1">Odometer Reading (km)</label>
                  <input
                    type="number"
                    required
                    value={odometer}
                    onChange={(e) => setOdometer(Number(e.target.value))}
                    className="input w-full bg-base-950 border-base-700 text-ink-100"
                  />
                </div>

                <div>
                  <label className="block text-ink-300 mb-1">Date</label>
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="input w-full bg-base-950 border-base-700 text-ink-100"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="btn-secondary px-4 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="btn-amber px-4 py-2"
                >
                  {submitting ? "Processing Rules…" : "Ingest & Reconcile"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
