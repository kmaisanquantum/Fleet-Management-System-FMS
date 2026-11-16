import { FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";
import { StatusBadge } from "./driver/shared";

type Tab = "faults" | "incidents" | "leave" | "documents" | "fuel" | "inspections" | "maintenance" | "notify";

const TABS: { key: Tab; label: string }[] = [
  { key: "faults", label: "Faults" },
  { key: "incidents", label: "Incidents" },
  { key: "leave", label: "Leave" },
  { key: "documents", label: "Documents" },
  { key: "fuel", label: "Fuel Verification" },
  { key: "inspections", label: "Inspections" },
  { key: "maintenance", label: "Maintenance" },
  { key: "notify", label: "Send Notification" },
];

const ENDPOINT: Record<Exclude<Tab, "notify">, string> = {
  faults: "faults",
  incidents: "incidents",
  leave: "leave",
  documents: "documents",
  fuel: "fuel-logs",
  inspections: "inspections",
  maintenance: "maintenance-requests",
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-5">
      <h2 className="font-display font-semibold text-ink-100 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function SubmissionsTable({ cols, children }: { cols: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="table-shell">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function ActionSelect({ path, body, options, ok }: { path: string; body: (v: string) => unknown; options: string[]; ok: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <select
      className="input py-1 text-xs"
      defaultValue=""
      disabled={busy}
      onChange={async (e) => {
        if (!e.target.value) return;
        setBusy(true);
        try {
          await api.patch(path, body(e.target.value));
          window.location.reload();
        } catch (err: any) {
          alert(err.message || ok);
        } finally {
          setBusy(false);
        }
      }}
    >
      <option value="">Set…</option>
      {options.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
    </select>
  );
}

export default function DriverSubmissions() {
  const [tab, setTab] = useState<Tab>("faults");
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    if (tab === "notify") return;
    setLoading(true);
    api
      .get<{ data: any[] }>(`/driver-admin/${ENDPOINT[tab]}`)
      .then((res) => setItems(res.data || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }

  useEffect(load, [tab]);

  async function patch(path: string, body: unknown, ok: string) {
    setMessage(null);
    try {
      await api.patch(path, body);
      setMessage(ok);
      load();
    } catch (err: any) {
      setMessage(err.message || "Action failed");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold text-ink-100">Driver Submissions</h1>
        <p className="text-sm text-ink-400">Review, verify and action submissions from the Driver Portal</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setMessage(null); }}
            className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
              tab === t.key ? "bg-amber-400 text-base-950 border-amber-400 font-semibold" : "border-base-600 text-ink-300 hover:bg-base-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {message && <div className="text-sm text-amber-400">{message}</div>}

      {tab === "faults" && (
        <Panel title="Reported Faults">
          <SubmissionsTable cols={["Vehicle", "Driver", "Severity", "Description", "Status", "Action"]}>
            {items.map((f) => (
              <tr key={f.id}>
                <td className="text-amber-400">{f.vehicle_number}</td>
                <td>{f.driver_name ?? "—"}</td>
                <td><StatusBadge value={f.severity} /></td>
                <td className="max-w-xs truncate">{f.description}</td>
                <td><StatusBadge value={f.status} /></td>
                <td>
                  <ActionSelect
                    path={`/driver-admin/faults/${f.id}`}
                    body={(v) => ({ status: v })}
                    options={["acknowledged", "in_progress", "resolved", "cleared", "rejected"]}
                    ok="Fault updated"
                  />
                </td>
              </tr>
            ))}
          </SubmissionsTable>
        </Panel>
      )}

      {tab === "incidents" && (
        <Panel title="Incident Reports">
          <SubmissionsTable cols={["Date", "Type", "Driver", "Injuries", "Status", "Action"]}>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.incident_date}</td>
                <td className="capitalize">{i.incident_type.replace(/_/g, " ")}</td>
                <td>{i.driver_name ?? "—"}</td>
                <td>{i.injuries ? "Yes" : "No"}</td>
                <td><StatusBadge value={i.status} /></td>
                <td>
                  <ActionSelect
                    path={`/driver-admin/incidents/${i.id}`}
                    body={(v) => ({ status: v })}
                    options={["under_review", "investigating", "closed"]}
                    ok="Incident updated"
                  />
                </td>
              </tr>
            ))}
          </SubmissionsTable>
        </Panel>
      )}

      {tab === "leave" && (
        <Panel title="Leave Requests">
          <SubmissionsTable cols={["Driver", "Type", "Dates", "Status", "Action"]}>
            {items.map((l) => (
              <tr key={l.id}>
                <td>{l.driver_name ?? "—"}</td>
                <td className="capitalize">{l.leave_type}</td>
                <td>{l.start_date} → {l.end_date}</td>
                <td><StatusBadge value={l.status} /></td>
                <td>
                  <ActionSelect
                    path={`/driver-admin/leave/${l.id}`}
                    body={(v) => ({ status: v })}
                    options={["approved", "rejected", "cancelled"]}
                    ok="Leave updated"
                  />
                </td>
              </tr>
            ))}
          </SubmissionsTable>
        </Panel>
      )}

      {tab === "documents" && (
        <Panel title="Driver Documents">
          <SubmissionsTable cols={["Driver", "Type", "Title", "Expiry", "Status", "Action"]}>
            {items.map((d) => (
              <tr key={d.id}>
                <td>{d.driver_name ?? "—"}</td>
                <td className="capitalize">{d.document_type}</td>
                <td>{d.title}</td>
                <td>{d.expiry_date ?? "—"}</td>
                <td><StatusBadge value={d.status} /></td>
                <td>
                  <div className="flex items-center gap-2">
                    {d.file_url && <a className="text-xs text-amber-400 hover:underline" href={d.file_url} target="_blank" rel="noreferrer">View</a>}
                    <ActionSelect
                      path={`/driver-admin/documents/${d.id}`}
                      body={(v) => ({ status: v })}
                      options={["verified", "rejected", "expired"]}
                      ok="Document updated"
                    />
                  </div>
                </td>
              </tr>
            ))}
          </SubmissionsTable>
        </Panel>
      )}

      {tab === "fuel" && (
        <Panel title="Fuel Log Verification">
          <SubmissionsTable cols={["Date", "Vehicle", "Driver", "Litres", "Cost", "Status", "Action"]}>
            {items.map((f) => (
              <tr key={f.id}>
                <td>{f.date}</td>
                <td className="text-amber-400">{f.vehicle_number}</td>
                <td>{f.driver_name ?? "—"}</td>
                <td className="font-mono">{f.litres}</td>
                <td className="font-mono">{f.total_cost?.toLocaleString()}</td>
                <td><StatusBadge value={f.reconciliation_status} /></td>
                <td>
                  <ActionSelect
                    path={`/driver-admin/fuel-logs/${f.id}/verify`}
                    body={(v) => ({ reconciliationStatus: v })}
                    options={["verified", "exception", "pending"]}
                    ok="Fuel log verified"
                  />
                </td>
              </tr>
            ))}
          </SubmissionsTable>
        </Panel>
      )}

      {tab === "inspections" && (
        <Panel title="Driver Inspections">
          <SubmissionsTable cols={["Date", "Vehicle", "Driver", "Result", "Cleared", "Action"]}>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.inspection_date}</td>
                <td className="text-amber-400">{i.vehicle_number}</td>
                <td>{i.driver_name ?? "—"}</td>
                <td><StatusBadge value={i.result} /></td>
                <td>{i.cleared ? "Yes" : "No"}</td>
                <td>
                  {i.result === "fail" && !i.cleared && (
                    <button className="btn-secondary text-xs" onClick={() => patch(`/driver-admin/inspections/${i.id}/clear`, {}, "Inspection cleared")}>
                      Clear
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </SubmissionsTable>
        </Panel>
      )}

      {tab === "maintenance" && (
        <Panel title="Maintenance Requests">
          <SubmissionsTable cols={["Vehicle", "Driver", "Type", "Description", "Status", "Action"]}>
            {items.map((m) => (
              <tr key={m.id}>
                <td className="text-amber-400">{m.vehicle_number}</td>
                <td>{m.driver_name ?? "—"}</td>
                <td className="capitalize">{m.maintenance_type.replace(/_/g, " ")}</td>
                <td className="max-w-xs truncate">{m.description}</td>
                <td><StatusBadge value={m.status} /></td>
                <td>
                  <ActionSelect
                    path={`/driver-admin/maintenance-requests/${m.id}`}
                    body={(v) => ({ status: v })}
                    options={["scheduled", "in_progress", "completed", "cancelled"]}
                    ok="Request updated"
                  />
                </td>
              </tr>
            ))}
          </SubmissionsTable>
        </Panel>
      )}

      {tab === "notify" && <NotifyForm onSent={() => setMessage("Notification sent")} />}

      {loading && <div className="text-sm text-ink-400">Loading…</div>}
    </div>
  );
}

function NotifyForm({ onSent }: { onSent: () => void }) {
  const [drivers, setDrivers] = useState<{ id: string; name: string; employee_number: string }[]>([]);
  const [driverId, setDriverId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ data: { id: string; name: string; employee_number: string }[] }>("/drivers").then((res) => {
      setDrivers(res.data || []);
      if (res.data?.length) setDriverId(res.data[0].id);
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/driver-admin/notifications", { driverId, title, body });
      setTitle("");
      setBody("");
      onSent();
    } catch (err: any) {
      setError(err.message || "Failed to send notification");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Send Notification to Driver">
      <form onSubmit={submit} className="space-y-3 max-w-lg">
        {error && <div className="text-sm text-signal-red">{error}</div>}
        <div>
          <label className="label">Driver *</label>
          <select className="input" value={driverId} onChange={(e) => setDriverId(e.target.value)} required>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.employee_number})</option>)}
          </select>
        </div>
        <div>
          <label className="label">Title *</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div>
          <label className="label">Message *</label>
          <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} required />
        </div>
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Sending…" : "Send"}</button>
      </form>
    </Panel>
  );
}
