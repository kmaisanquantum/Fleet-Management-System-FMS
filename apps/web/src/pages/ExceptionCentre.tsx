import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "../api/client";

interface FleetException {
  id: string;
  severity: "critical" | "warning" | "info";
  category: string;
  rule_code: string;
  vehicle_id: string;
  driver_id?: string;
  transaction_id?: string;
  description: string;
  status: "open" | "investigating" | "resolved" | "dismissed";
  notes?: string;
  resolution?: string;
  created_at: string;
  vehicle_number?: string;
  registration_number?: string;
  driver_name?: string;
  txn_litres?: number;
  txn_cost?: number;
  txn_station?: string;
}

interface ExceptionDetailResponse {
  data: FleetException & {
    supportingData: {
      transaction: any;
      gpsPosition: any;
    };
  };
}

export default function ExceptionCentre() {
  const [exceptions, setExceptions] = useState<FleetException[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeSeverity, setActiveSeverity] = useState<string>("all");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [activeStatus, setActiveStatus] = useState<string>("open");

  // Detail drawer state
  const [selectedException, setSelectedException] = useState<any | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // Form state
  const [updateStatus, setUpdateStatus] = useState<string>("investigating");
  const [updateNotes, setUpdateNotes] = useState("");
  const [updateResolution, setUpdateResolution] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadExceptions();
  }, [activeSeverity, activeCategory, activeStatus]);

  async function loadExceptions() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (activeSeverity !== "all") params.append("severity", activeSeverity);
      if (activeCategory !== "all") params.append("category", activeCategory);
      if (activeStatus !== "all") params.append("status", activeStatus);

      const res = await apiGet<{ data: FleetException[]; summary: any }>(`/exceptions?${params.toString()}`);
      setExceptions(res.data);
      setSummary(res.summary);
    } catch (err) {
      console.error("Failed to load exceptions:", err);
    } finally {
      setLoading(false);
    }
  }

  async function openDrawer(id: string) {
    setDrawerLoading(true);
    setSelectedException(null);
    try {
      const res = await apiGet<ExceptionDetailResponse>(`/exceptions/${id}`);
      setSelectedException(res.data);
      setUpdateStatus(res.data.status);
      setUpdateNotes(res.data.notes || "");
      setUpdateResolution(res.data.resolution || "");
    } catch (err) {
      console.error("Failed to fetch exception detail:", err);
    } finally {
      setDrawerLoading(false);
    }
  }

  async function handleUpdateException(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedException) return;

    setSubmitting(true);
    try {
      await apiPatch(`/exceptions/${selectedException.id}`, {
        status: updateStatus,
        notes: updateNotes,
        resolution: updateResolution,
      });
      setSelectedException(null);
      loadExceptions();
    } catch (err: any) {
      alert(err.message || "Failed to update exception");
    } finally {
      setSubmitting(false);
    }
  }

  const CATEGORIES = ["all", "fuel", "gps", "security", "driver", "vehicle", "maintenance", "compliance"];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Fleet Exception Centre</h1>
          <p className="text-sm text-ink-400">Automated fraud detection, fuel variance alerts, and operational risk investigation</p>
        </div>
      </div>

      {/* Severity Summary Bar */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <button
            onClick={() => { setActiveSeverity("all"); setActiveStatus("open"); }}
            className={`p-4 rounded-xl border text-left transition-all ${
              activeSeverity === "all" ? "bg-base-900 border-amber-400" : "bg-base-900 border-base-700"
            }`}
          >
            <div className="text-xs uppercase text-ink-500 font-semibold">Total Open</div>
            <div className="text-2xl font-bold text-ink-100 mt-1">{summary.open_count || 0}</div>
          </button>

          <button
            onClick={() => { setActiveSeverity("critical"); setActiveStatus("open"); }}
            className={`p-4 rounded-xl border text-left transition-all ${
              activeSeverity === "critical" ? "bg-red-950/60 border-red-500" : "bg-base-900 border-red-900/40"
            }`}
          >
            <div className="text-xs uppercase text-red-400 font-semibold">Critical</div>
            <div className="text-2xl font-bold text-red-400 mt-1">{summary.critical_open || 0}</div>
          </button>

          <button
            onClick={() => { setActiveSeverity("warning"); setActiveStatus("open"); }}
            className={`p-4 rounded-xl border text-left transition-all ${
              activeSeverity === "warning" ? "bg-amber-950/60 border-amber-500" : "bg-base-900 border-amber-900/40"
            }`}
          >
            <div className="text-xs uppercase text-amber-400 font-semibold">Warning</div>
            <div className="text-2xl font-bold text-amber-400 mt-1">{summary.warning_open || 0}</div>
          </button>

          <button
            onClick={() => { setActiveSeverity("info"); setActiveStatus("open"); }}
            className={`p-4 rounded-xl border text-left transition-all ${
              activeSeverity === "info" ? "bg-blue-950/60 border-blue-500" : "bg-base-900 border-blue-900/40"
            }`}
          >
            <div className="text-xs uppercase text-blue-400 font-semibold">Info / Advisory</div>
            <div className="text-2xl font-bold text-blue-400 mt-1">{summary.info_open || 0}</div>
          </button>
        </div>
      )}

      {/* Filter Tabs & Category Pills */}
      <div className="bg-base-900 border border-base-700 rounded-xl p-4 space-y-4">
        {/* Status Tabs */}
        <div className="flex border-b border-base-700 gap-6 text-sm">
          {["open", "investigating", "resolved", "dismissed", "all"].map((statusKey) => (
            <button
              key={statusKey}
              onClick={() => setActiveStatus(statusKey)}
              className={`pb-2 capitalize border-b-2 font-medium transition-colors ${
                activeStatus === statusKey
                  ? "border-amber-400 text-amber-400"
                  : "border-transparent text-ink-400 hover:text-ink-200"
              }`}
            >
              {statusKey}
            </button>
          ))}
        </div>

        {/* Category Pills */}
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-ink-500 uppercase font-semibold mr-2">Category:</span>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
                activeCategory === cat
                  ? "bg-amber-400 text-base-950 font-bold"
                  : "bg-base-800 text-ink-300 hover:bg-base-700"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Exceptions List */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-ink-400">Loading exception records…</div>
        ) : exceptions.length === 0 ? (
          <div className="p-12 text-center text-ink-500">No fleet exceptions found matching the current filters.</div>
        ) : (
          <div className="divide-y divide-base-800">
            {exceptions.map((exc) => (
              <div
                key={exc.id}
                onClick={() => openDrawer(exc.id)}
                className="p-4 hover:bg-base-800/50 cursor-pointer transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="space-y-1.5 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`px-2.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                      exc.severity === "critical"
                        ? "bg-red-500/20 text-red-400 border border-red-500/40"
                        : exc.severity === "warning"
                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                        : "bg-blue-500/20 text-blue-400 border border-blue-500/40"
                    }`}>
                      {exc.severity}
                    </span>
                    <span className="text-xs font-mono font-bold text-amber-400">{exc.rule_code}</span>
                    <span className="text-xs px-2 py-0.5 bg-base-800 text-ink-300 rounded font-medium capitalize">{exc.category}</span>
                  </div>
                  <div className="text-sm font-medium text-ink-100">{exc.description}</div>
                  <div className="text-xs text-ink-400 flex flex-wrap gap-4">
                    <span><strong>Vehicle:</strong> {exc.vehicle_number || "N/A"} ({exc.registration_number || ""})</span>
                    <span><strong>Driver:</strong> {exc.driver_name || "Unassigned"}</span>
                    <span><strong>Logged:</strong> {new Date(exc.created_at).toLocaleString()}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className={`px-3 py-1 rounded-md text-xs font-medium capitalize ${
                    exc.status === "open"
                      ? "bg-red-950 text-red-400 border border-red-800"
                      : exc.status === "investigating"
                      ? "bg-amber-950 text-amber-400 border border-amber-800"
                      : "bg-emerald-950 text-emerald-400 border border-emerald-800"
                  }`}>
                    {exc.status}
                  </span>
                  <span className="text-ink-500 text-lg">&rarr;</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Exception Detail Side Drawer */}
      {(selectedException || drawerLoading) && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-xl bg-base-900 h-full overflow-y-auto border-l border-base-700 p-6 space-y-6 flex flex-col justify-between">
            {drawerLoading ? (
              <div className="text-ink-400 py-12 text-center">Loading supporting details…</div>
            ) : selectedException && (
              <>
                <div className="space-y-6">
                  {/* Drawer Header */}
                  <div className="flex items-center justify-between border-b border-base-700 pb-4">
                    <div>
                      <div className="text-xs font-mono text-amber-400 uppercase font-bold">{selectedException.rule_code}</div>
                      <h2 className="text-lg font-bold text-ink-100 mt-1">Exception Investigation</h2>
                    </div>
                    <button onClick={() => setSelectedException(null)} className="text-ink-400 hover:text-ink-100 text-xl font-bold">
                      &times;
                    </button>
                  </div>

                  {/* Violation Details */}
                  <div className="bg-base-950 border border-base-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${
                        selectedException.severity === "critical" ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"
                      }`}>
                        {selectedException.severity}
                      </span>
                      <span className="text-xs text-ink-400 uppercase font-medium">{selectedException.category}</span>
                    </div>
                    <p className="text-sm text-ink-200 font-medium">{selectedException.description}</p>
                    <div className="text-xs text-ink-400">Created: {new Date(selectedException.created_at).toLocaleString()}</div>
                  </div>

                  {/* Supporting Transaction Data */}
                  {selectedException.supportingData?.transaction && (
                    <div className="bg-base-950 border border-base-800 rounded-xl p-4 space-y-2">
                      <h3 className="text-xs font-semibold text-ink-400 uppercase tracking-wider">Supporting Fuel Transaction</h3>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><strong className="text-ink-400">Station:</strong> {selectedException.supportingData.transaction.station_name || selectedException.supportingData.transaction.station}</div>
                        <div><strong className="text-ink-400">Card No:</strong> {selectedException.supportingData.transaction.card_number || "N/A"}</div>
                        <div><strong className="text-ink-400">Litres:</strong> {selectedException.supportingData.transaction.litres} L</div>
                        <div><strong className="text-ink-400">Total Cost:</strong> K {selectedException.supportingData.transaction.total_cost}</div>
                        <div><strong className="text-ink-400">Odometer:</strong> {selectedException.supportingData.transaction.odometer_reading} km</div>
                        <div><strong className="text-ink-400">Receipt Ref:</strong> {selectedException.supportingData.transaction.receipt_ref || "N/A"}</div>
                      </div>
                    </div>
                  )}

                  {/* Supporting GPS Data */}
                  {selectedException.supportingData?.gpsPosition && (
                    <div className="bg-base-950 border border-base-800 rounded-xl p-4 space-y-2">
                      <h3 className="text-xs font-semibold text-ink-400 uppercase tracking-wider">Supporting GPS Position</h3>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><strong className="text-ink-400">Coordinates:</strong> {selectedException.supportingData.gpsPosition.lat}, {selectedException.supportingData.gpsPosition.lon}</div>
                        <div><strong className="text-ink-400">Speed:</strong> {selectedException.supportingData.gpsPosition.speed} km/h</div>
                        <div><strong className="text-ink-400">Recorded At:</strong> {selectedException.supportingData.gpsPosition.recorded_at}</div>
                      </div>
                    </div>
                  )}

                  {/* Status & Resolution Form */}
                  <form onSubmit={handleUpdateException} className="space-y-4 pt-4 border-t border-base-700">
                    <div>
                      <label className="block text-xs font-medium text-ink-300 mb-1">Update Status</label>
                      <select
                        value={updateStatus}
                        onChange={(e) => setUpdateStatus(e.target.value)}
                        className="input text-xs w-full bg-base-950 border-base-700 text-ink-100"
                      >
                        <option value="open">Open</option>
                        <option value="investigating">Investigating</option>
                        <option value="resolved">Resolved</option>
                        <option value="dismissed">Dismissed</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-ink-300 mb-1">Investigation Notes</label>
                      <textarea
                        rows={3}
                        value={updateNotes}
                        onChange={(e) => setUpdateNotes(e.target.value)}
                        placeholder="Add investigation findings or comments…"
                        className="input text-xs w-full bg-base-950 border-base-700 text-ink-100"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-ink-300 mb-1">Resolution Summary</label>
                      <textarea
                        rows={2}
                        value={updateResolution}
                        onChange={(e) => setUpdateResolution(e.target.value)}
                        placeholder="Action taken to resolve or dismiss exception…"
                        className="input text-xs w-full bg-base-950 border-base-700 text-ink-100"
                      />
                    </div>

                    <div className="flex gap-3 pt-2">
                      <button
                        type="submit"
                        disabled={submitting}
                        className="btn-amber text-xs font-semibold px-4 py-2 flex-1"
                      >
                        {submitting ? "Saving…" : "Save Exception Update"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedException(null)}
                        className="btn-secondary text-xs px-4 py-2"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
