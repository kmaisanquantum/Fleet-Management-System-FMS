import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { apiGet, apiPut } from "../api/client";

interface BusinessRule {
  key: string;
  value: string;
  value_type: "number" | "string" | "boolean";
  label?: string;
  description?: string;
  updated_at?: string;
  updated_by_name?: string;
}

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await apiGet<{ data: BusinessRule[] }>("/settings");
      setRules(res.data);
      const initialForm: Record<string, string> = {};
      for (const r of res.data) {
        initialForm[r.key] = r.value;
      }
      setFormData(initialForm);
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to load business rules" });
    } finally {
      setLoading(false);
    }
  }

  function handleInputChange(key: string, val: string) {
    setFormData((prev) => ({ ...prev, [key]: val }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!isAdmin) return;

    setSaving(true);
    setMessage(null);
    try {
      const payload = Object.entries(formData).map(([key, value]) => ({ key, value }));
      await apiPut("/settings", payload);
      setMessage({ type: "success", text: "System settings updated successfully." });
      loadSettings();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to update settings" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink-100">System Settings</h1>
        <p className="text-sm text-ink-500">Configurable operational thresholds and business rules backed by the database</p>
      </div>

      {message && (
        <div
          className={`p-4 rounded-xl border text-xs font-medium ${
            message.type === "success"
              ? "bg-emerald-950/60 border-emerald-500/50 text-emerald-400"
              : "bg-red-950/60 border-red-500/50 text-red-400"
          }`}
        >
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="panel p-8 text-center text-ink-400 text-sm">Loading system settings…</div>
      ) : (
        <form onSubmit={handleSave} className="space-y-6">
          <div className="panel p-6 divide-y divide-base-800">
            {rules.map((rule) => (
              <div key={rule.key} className="py-4 first:pt-0 last:pb-0 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1 max-w-lg">
                  <div className="text-sm font-semibold text-ink-100">{rule.label || rule.key}</div>
                  <div className="text-xs text-ink-400">{rule.description}</div>
                  <div className="text-[10px] text-ink-500 font-mono">
                    Key: {rule.key} | Type: {rule.value_type}
                    {rule.updated_at && ` | Updated: ${new Date(rule.updated_at).toLocaleDateString()}`}
                  </div>
                </div>

                <div className="w-full md:w-64 shrink-0">
                  {rule.value_type === "boolean" ? (
                    <select
                      disabled={!isAdmin}
                      value={formData[rule.key] || "false"}
                      onChange={(e) => handleInputChange(rule.key, e.target.value)}
                      className="input text-xs w-full bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    >
                      <option value="false">No (False)</option>
                      <option value="true">Yes (True)</option>
                    </select>
                  ) : rule.value_type === "number" ? (
                    <input
                      type="number"
                      step="any"
                      disabled={!isAdmin}
                      value={formData[rule.key] ?? ""}
                      onChange={(e) => handleInputChange(rule.key, e.target.value)}
                      className="input text-xs w-full bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  ) : (
                    <input
                      type="text"
                      disabled={!isAdmin}
                      value={formData[rule.key] ?? ""}
                      onChange={(e) => handleInputChange(rule.key, e.target.value)}
                      className="input text-xs w-full bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-2">
            {!isAdmin ? (
              <span className="text-xs text-amber-400">Viewing mode (Admin permissions required to modify system settings).</span>
            ) : (
              <span className="text-xs text-ink-500">Changes are immediately applied and recorded in the audit log.</span>
            )}

            {isAdmin && (
              <button
                type="submit"
                disabled={saving}
                className="btn-amber text-xs font-semibold px-6 py-2.5 rounded-lg"
              >
                {saving ? "Saving Changes…" : "Save Business Rules"}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
