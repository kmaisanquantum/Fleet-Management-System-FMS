import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { DriverNotification } from "../../types";
import { EmptyState, PageHeader } from "./shared";

export default function Notifications() {
  const [items, setItems] = useState<DriverNotification[]>([]);
  const [loading, setLoading] = useState(true);

  function load() {
    api
      .get<{ data: DriverNotification[] }>("/driver-portal/notifications")
      .then((res) => setItems(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function markRead(id: string) {
    try {
      await api.post(`/driver-portal/notifications/${id}/read`);
      load();
    } catch {
      /* ignore */
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading notifications…</div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" subtitle="Messages and alerts from fleet administrators" />
      {items.length === 0 ? (
        <div className="panel"><EmptyState>No notifications.</EmptyState></div>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id} className={`panel p-4 ${n.is_read ? "" : "border-amber-400/50"}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-ink-100">{n.title}</div>
                  <div className="text-sm text-ink-300 mt-1">{n.body}</div>
                  <div className="text-xs text-ink-500 mt-2">{n.category} · {n.created_at}</div>
                </div>
                {!n.is_read && (
                  <button className="btn-secondary text-xs shrink-0" onClick={() => markRead(n.id)}>
                    Mark read
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
