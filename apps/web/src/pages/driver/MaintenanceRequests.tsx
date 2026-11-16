import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { VehicleMaintenance } from "../../types";
import { EmptyState, Field, Modal, PageHeader, StatusBadge } from "./shared";

export default function MaintenanceRequests() {
  const [requests, setRequests] = useState<VehicleMaintenance[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [description, setDescription] = useState("");
  const [maintenanceType, setMaintenanceType] = useState("unscheduled_repair");
  const [preferredDate, setPreferredDate] = useState("");

  function load() {
    api
      .get<{ data: VehicleMaintenance[] }>("/driver-portal/maintenance-requests")
      .then((res) => setRequests(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/driver-portal/maintenance-requests", {
        description,
        maintenanceType,
        preferredDate: preferredDate || undefined,
      });
      setShowForm(false);
      setDescription("");
      setPreferredDate("");
      load();
    } catch (err: any) {
      setError(err.message || "Failed to submit request");
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading maintenance requests…</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Maintenance Requests"
        subtitle="Submit and track vehicle maintenance requests"
        action={<button className="btn-primary" onClick={() => setShowForm(true)}>New Request</button>}
      />

      {requests.length === 0 ? (
        <div className="panel"><EmptyState>You have no maintenance requests.</EmptyState></div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-ink-100">{r.description}</div>
                <StatusBadge value={r.status} />
              </div>
              <div className="text-xs text-ink-500 mt-2">
                {r.vehicle_number} · {r.maintenance_type.replace(/_/g, " ")}
                {r.scheduled_date ? ` · scheduled ${r.scheduled_date}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="Maintenance Request" onClose={() => setShowForm(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <div>
              <label className="label">Type *</label>
              <select className="input" value={maintenanceType} onChange={(e) => setMaintenanceType(e.target.value)}>
                <option value="unscheduled_repair">Unscheduled Repair</option>
                <option value="scheduled_service">Scheduled Service</option>
                <option value="inspection_fix">Inspection Fix</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="label">Description *</label>
              <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} required />
            </div>
            <Field label="Preferred Date" type="date" value={preferredDate} onChange={(e) => setPreferredDate(e.target.value)} />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn-primary">Submit Request</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
