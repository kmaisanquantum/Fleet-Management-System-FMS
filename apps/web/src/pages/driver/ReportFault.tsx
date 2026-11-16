import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { VehicleFault } from "../../types";
import { EmptyState, Field, Modal, PageHeader, PhotoUpload, StatusBadge } from "./shared";

const CATEGORIES = ["engine", "brakes", "tyres", "electrical", "transmission", "body", "cooling", "steering", "other"];

export default function ReportFault() {
  const [faults, setFaults] = useState<VehicleFault[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState("engine");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<"minor" | "major" | "critical">("minor");
  const [odometer, setOdometer] = useState<number | "">("");
  const [photos, setPhotos] = useState<string[]>([]);

  function load() {
    api
      .get<{ data: VehicleFault[] }>("/driver-portal/faults")
      .then((res) => setFaults(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/driver-portal/faults", {
        category,
        description,
        severity,
        odometer: odometer === "" ? undefined : odometer,
        photoUrls: photos,
      });
      setShowForm(false);
      setDescription("");
      setSeverity("minor");
      setOdometer("");
      setPhotos([]);
      load();
    } catch (err: any) {
      setError(err.message || "Failed to report fault");
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading faults…</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Report Vehicle Fault"
        subtitle="Report a defect with your vehicle for maintenance follow-up"
        action={<button className="btn-primary" onClick={() => setShowForm(true)}>Report Fault</button>}
      />

      {faults.length === 0 ? (
        <div className="panel"><EmptyState>You have not reported any faults.</EmptyState></div>
      ) : (
        <div className="space-y-3">
          {faults.map((f) => (
            <div key={f.id} className="panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-ink-100 capitalize">{f.category} · {f.description}</div>
                <div className="flex gap-2">
                  <StatusBadge value={f.severity} />
                  <StatusBadge value={f.status} />
                </div>
              </div>
              <div className="text-xs text-ink-500 mt-2">
                {f.vehicle_number} {f.odometer ? `· ${f.odometer.toLocaleString()} km` : ""} · {f.created_at}
              </div>
              {f.admin_notes && <div className="text-xs text-ink-300 mt-1">Admin: {f.admin_notes}</div>}
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="Report Vehicle Fault" onClose={() => setShowForm(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <div>
              <label className="label">Category *</label>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Severity *</label>
              <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value as any)}>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="label">Description *</label>
              <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} required />
            </div>
            <Field
              label="Odometer (km)"
              type="number"
              value={odometer}
              onChange={(e) => setOdometer(e.target.value === "" ? "" : Number(e.target.value))}
            />
            <PhotoUpload label="Photos" value={photos} onChange={setPhotos} capture />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn-primary">Submit</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
