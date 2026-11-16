import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { DriverLeaveRequest } from "../../types";
import { EmptyState, Field, Modal, PageHeader, StatusBadge } from "./shared";

export default function LeaveRequests() {
  const [requests, setRequests] = useState<DriverLeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [leaveType, setLeaveType] = useState("annual");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");

  function load() {
    api
      .get<{ data: DriverLeaveRequest[] }>("/driver-portal/leave")
      .then((res) => setRequests(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/driver-portal/leave", { leaveType, startDate, endDate, reason: reason || undefined });
      setShowForm(false);
      setReason("");
      load();
    } catch (err: any) {
      setError(err.message || "Failed to submit leave request");
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading leave requests…</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leave / Absence Requests"
        subtitle="Request leave and track approval status"
        action={<button className="btn-primary" onClick={() => setShowForm(true)}>New Request</button>}
      />

      {requests.length === 0 ? (
        <div className="panel"><EmptyState>You have no leave requests.</EmptyState></div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-ink-100 capitalize">{r.leave_type} leave</div>
                <StatusBadge value={r.status} />
              </div>
              <div className="text-xs text-ink-500 mt-2">{r.start_date} → {r.end_date}</div>
              {r.reason && <div className="text-sm text-ink-300 mt-1">{r.reason}</div>}
              {r.admin_notes && <div className="text-xs text-ink-300 mt-1">Admin: {r.admin_notes}</div>}
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="Leave Request" onClose={() => setShowForm(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <div>
              <label className="label">Leave Type *</label>
              <select className="input" value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
                <option value="annual">Annual</option>
                <option value="sick">Sick</option>
                <option value="compassionate">Compassionate</option>
                <option value="unpaid">Unpaid</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start Date *" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
              <Field label="End Date *" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
            </div>
            <div>
              <label className="label">Reason</label>
              <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
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
