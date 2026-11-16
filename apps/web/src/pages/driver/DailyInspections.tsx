import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { ChecklistItemDef, DriverInspection } from "../../types";
import { EmptyState, Modal, PageHeader, PhotoUpload, StatusBadge } from "./shared";

type ItemState = { status: "satisfactory" | "defective" | "na"; comment: string };

export default function DailyInspections() {
  const [history, setHistory] = useState<DriverInspection[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItemDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, ItemState>>({});
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);

  function load() {
    Promise.all([
      api.get<{ data: DriverInspection[] }>("/driver-portal/inspections"),
      api.get<{ data: ChecklistItemDef[] }>("/driver-portal/inspections/checklist"),
    ])
      .then(([hist, defs]) => {
        setHistory(hist.data || []);
        setChecklist(defs.data || []);
        const initial: Record<string, ItemState> = {};
        for (const d of defs.data || []) initial[d.key] = { status: "satisfactory", comment: "" };
        setResult(initial);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function setItem(key: string, patch: Partial<ItemState>) {
    setResult((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const items = checklist.map((c) => ({
      key: c.key,
      status: result[c.key]?.status ?? "satisfactory",
      comment: result[c.key]?.comment || undefined,
    }));
    try {
      await api.post("/driver-portal/inspections", { items, notes: notes || undefined, photoUrls: photos });
      setShowForm(false);
      setNotes("");
      setPhotos([]);
      const reset: Record<string, ItemState> = {};
      for (const c of checklist) reset[c.key] = { status: "satisfactory", comment: "" };
      setResult(reset);
      load();
    } catch (err: any) {
      setError(err.message || "Failed to submit inspection");
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading inspections…</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Daily Inspections"
        subtitle="Complete your pre-trip vehicle safety checklist"
        action={<button className="btn-primary" onClick={() => setShowForm(true)}>New Inspection</button>}
      />

      {history.length === 0 ? (
        <div className="panel"><EmptyState>No inspections recorded yet.</EmptyState></div>
      ) : (
        <div className="space-y-3">
          {history.map((insp) => (
            <div key={insp.id} className="panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm text-ink-100">{insp.vehicle_number} · {insp.inspection_date}</div>
                  <div className="text-xs text-ink-500">{insp.inspector_name}</div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge value={insp.result} />
                  {insp.result === "fail" && <StatusBadge value={insp.cleared ? "cleared" : "pending"} />}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
                {(insp.items || []).map((it) => (
                  <div key={it.id} className="text-xs">
                    <span className="text-ink-400">{it.label}: </span>
                    <StatusBadge value={it.status} />
                  </div>
                ))}
              </div>
              {insp.notes && <div className="text-xs text-ink-400 mt-2">Notes: {insp.notes}</div>}
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="Daily Vehicle Inspection" onClose={() => setShowForm(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <div className="space-y-3">
              {checklist.map((c) => (
                <div key={c.key} className="border-b border-base-700 pb-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-ink-100">
                      {c.label} {c.critical && <span className="text-[10px] uppercase text-signal-red ml-1">critical</span>}
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    {(["satisfactory", "defective", "na"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setItem(c.key, { status: s })}
                        className={`flex-1 text-xs py-2 rounded border transition-colors ${
                          result[c.key]?.status === s
                            ? s === "defective"
                              ? "bg-red-950 border-signal-red text-signal-red"
                              : s === "na"
                                ? "bg-base-700 border-base-500 text-ink-200"
                                : "bg-emerald-950 border-signal-green text-signal-green"
                            : "border-base-600 text-ink-400 hover:bg-base-800"
                        }`}
                      >
                        {s === "na" ? "N/A" : s}
                      </button>
                    ))}
                  </div>
                  {result[c.key]?.status === "defective" && (
                    <input
                      className="input mt-2"
                      placeholder="Describe the defect…"
                      value={result[c.key]?.comment ?? ""}
                      onChange={(e) => setItem(c.key, { comment: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </div>
            <div>
              <label className="label">Notes</label>
              <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <PhotoUpload label="Photos" value={photos} onChange={setPhotos} capture />
            <div className="flex justify-end gap-3">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn-primary">Submit Inspection</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
