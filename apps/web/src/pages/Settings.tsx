import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { apiGet, apiPut, apiPost, apiDel } from "../api/client";

interface BusinessRule {
  key: string;
  value: string;
  value_type: "number" | "string" | "boolean";
  label?: string;
  description?: string;
  updated_at?: string;
  updated_by_name?: string;
}

interface IoFeatureRow {
  id: string;
  io_id: number;
  feature_key: string;
  label: string;
  value_type: "event" | "scalar" | "boolean";
  enabled: number;
  scale_factor: number;
}

interface ParamMapRow {
  id: string;
  feature_key: string;
  param_id: number;
  description: string | null;
}

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [ioFeatures, setIoFeatures] = useState<IoFeatureRow[]>([]);
  const [paramMap, setParamMap] = useState<ParamMapRow[]>([]);
  const [newIo, setNewIo] = useState({ io_id: "", feature_key: "", label: "", value_type: "event" as IoFeatureRow["value_type"], scale_factor: "1" });
  const [newParam, setNewParam] = useState({ feature_key: "", param_id: "", description: "" });

  useEffect(() => {
    loadSettings();
    loadMaps();
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

  /* -------------------- IO feature map + param map -------------------- */

  async function loadMaps() {
    try {
      const [ioRes, pmRes] = await Promise.all([
        apiGet<{ data: IoFeatureRow[] }>("/settings/io-features"),
        apiGet<{ data: ParamMapRow[] }>("/settings/param-map"),
      ]);
      setIoFeatures(ioRes.data);
      setParamMap(pmRes.data);
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to load device IO/param maps" });
    }
  }

  function patchIoRow(id: string, patch: Partial<IoFeatureRow>) {
    setIoFeatures((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveIoRow(row: IoFeatureRow) {
    try {
      await apiPut(`/settings/io-features/${row.id}`, {
        io_id: Number(row.io_id),
        feature_key: row.feature_key,
        label: row.label,
        value_type: row.value_type,
        enabled: !!row.enabled,
        scale_factor: Number(row.scale_factor) || 1,
      });
      setMessage({ type: "success", text: "IO feature mapping saved." });
      loadMaps();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to save IO feature mapping" });
    }
  }

  async function addIoRow() {
    const io_id = parseInt(newIo.io_id, 10);
    if (Number.isNaN(io_id) || !newIo.feature_key || !newIo.label) {
      setMessage({ type: "error", text: "IO id, feature key and label are required." });
      return;
    }
    try {
      await apiPost("/settings/io-features", { io_id, feature_key: newIo.feature_key, label: newIo.label, value_type: newIo.value_type, scale_factor: Number(newIo.scale_factor) || 1 });
      setNewIo({ io_id: "", feature_key: "", label: "", value_type: "event", scale_factor: "1" });
      setMessage({ type: "success", text: "IO feature mapping added." });
      loadMaps();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to add IO feature mapping" });
    }
  }

  async function deleteIoRow(id: string) {
    try {
      await apiDel(`/settings/io-features/${id}`);
      setMessage({ type: "success", text: "IO feature mapping deleted." });
      loadMaps();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to delete IO feature mapping" });
    }
  }

  function patchParamRow(id: string, patch: Partial<ParamMapRow>) {
    setParamMap((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveParamRow(row: ParamMapRow) {
    try {
      await apiPut(`/settings/param-map/${row.id}`, {
        feature_key: row.feature_key,
        param_id: Number(row.param_id),
        description: row.description ?? undefined,
      });
      setMessage({ type: "success", text: "Parameter mapping saved." });
      loadMaps();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to save parameter mapping" });
    }
  }

  async function addParamRow() {
    const param_id = parseInt(newParam.param_id, 10);
    if (Number.isNaN(param_id) || !newParam.feature_key) {
      setMessage({ type: "error", text: "Feature key and parameter id are required." });
      return;
    }
    try {
      await apiPost("/settings/param-map", { feature_key: newParam.feature_key, param_id, description: newParam.description || undefined });
      setNewParam({ feature_key: "", param_id: "", description: "" });
      setMessage({ type: "success", text: "Parameter mapping added." });
      loadMaps();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to add parameter mapping" });
    }
  }

  async function deleteParamRow(id: string) {
    try {
      await apiDel(`/settings/param-map/${id}`);
      setMessage({ type: "success", text: "Parameter mapping deleted." });
      loadMaps();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to delete parameter mapping" });
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

      {/* IO-ID → feature mapping (edit to match the FMB125 Configurator) */}
      <div className="panel p-6 space-y-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink-100">Teltonika IO Feature Map</h2>
          <p className="text-xs text-ink-500">
            Maps FMB125 IO element IDs to fleet features. Change these to match the device Configurator without a code change.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead>
              <tr>
                <th>IO ID</th>
                <th>Feature key</th>
                <th>Label</th>
                <th>Type</th>
                <th>Scale</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ioFeatures.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="number"
                      disabled={!isAdmin}
                      value={row.io_id}
                      onChange={(e) => patchIoRow(row.id, { io_id: Number(e.target.value) })}
                      className="input text-xs w-20 bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      disabled={!isAdmin}
                      value={row.feature_key}
                      onChange={(e) => patchIoRow(row.id, { feature_key: e.target.value })}
                      className="input text-xs w-40 bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      disabled={!isAdmin}
                      value={row.label}
                      onChange={(e) => patchIoRow(row.id, { label: e.target.value })}
                      className="input text-xs w-56 bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  </td>
                  <td>
                    <select
                      disabled={!isAdmin}
                      value={row.value_type}
                      onChange={(e) => patchIoRow(row.id, { value_type: e.target.value as IoFeatureRow["value_type"] })}
                      className="input text-xs w-28 bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    >
                      <option value="event">event</option>
                      <option value="scalar">scalar</option>
                      <option value="boolean">boolean</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.001"
                      disabled={!isAdmin}
                      value={row.scale_factor}
                      onChange={(e) => patchIoRow(row.id, { scale_factor: Number(e.target.value) })}
                      className="input text-xs w-24 bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      disabled={!isAdmin}
                      checked={!!row.enabled}
                      onChange={(e) => patchIoRow(row.id, { enabled: e.target.checked ? 1 : 0 })}
                    />
                  </td>
                  <td className="whitespace-nowrap">
                    {isAdmin && (
                      <>
                        <button onClick={() => saveIoRow(row)} className="text-xs text-amber-400 hover:underline mr-3">Save</button>
                        <button onClick={() => deleteIoRow(row.id)} className="text-xs text-signal-red hover:underline">Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-end gap-3 pt-2 border-t border-base-800">
            <div>
              <label className="label">IO ID</label>
              <input type="number" value={newIo.io_id} onChange={(e) => setNewIo({ ...newIo, io_id: e.target.value })}
                className="input text-xs w-24 bg-base-950 border-base-700 text-ink-100" />
            </div>
            <div>
              <label className="label">Feature key</label>
              <input type="text" value={newIo.feature_key} onChange={(e) => setNewIo({ ...newIo, feature_key: e.target.value })}
                className="input text-xs w-40 bg-base-950 border-base-700 text-ink-100" />
            </div>
            <div>
              <label className="label">Label</label>
              <input type="text" value={newIo.label} onChange={(e) => setNewIo({ ...newIo, label: e.target.value })}
                className="input text-xs w-56 bg-base-950 border-base-700 text-ink-100" />
            </div>
            <div>
              <label className="label">Type</label>
              <select value={newIo.value_type} onChange={(e) => setNewIo({ ...newIo, value_type: e.target.value as IoFeatureRow["value_type"] })}
                className="input text-xs w-28 bg-base-950 border-base-700 text-ink-100">
                <option value="event">event</option>
                <option value="scalar">scalar</option>
                <option value="boolean">boolean</option>
              </select>
            </div>
            <div>
              <label className="label">Scale</label>
              <input type="number" step="0.001" value={newIo.scale_factor} onChange={(e) => setNewIo({ ...newIo, scale_factor: e.target.value })}
                className="input text-xs w-24 bg-base-950 border-base-700 text-ink-100" />
            </div>
            <button onClick={addIoRow} className="btn-primary text-xs px-4 py-2">Add mapping</button>
          </div>
        )}
      </div>

      {/* Teltonika parameter-ID map (used to build setparam commands) */}
      <div className="panel p-6 space-y-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink-100">Teltonika Parameter Map</h2>
          <p className="text-xs text-ink-500">
            Maps feature keys to Teltonika parameter IDs used when building remote <span className="font-mono">setparam</span> commands.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead>
              <tr>
                <th>Feature key</th>
                <th>Param ID</th>
                <th>Description</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {paramMap.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="text"
                      disabled={!isAdmin}
                      value={row.feature_key}
                      onChange={(e) => patchParamRow(row.id, { feature_key: e.target.value })}
                      className="input text-xs w-44 bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      disabled={!isAdmin}
                      value={row.param_id}
                      onChange={(e) => patchParamRow(row.id, { param_id: Number(e.target.value) })}
                      className="input text-xs w-24 bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      disabled={!isAdmin}
                      value={row.description ?? ""}
                      onChange={(e) => patchParamRow(row.id, { description: e.target.value })}
                      className="input text-xs w-64 bg-base-950 border-base-700 text-ink-100 disabled:opacity-60"
                    />
                  </td>
                  <td className="whitespace-nowrap">
                    {isAdmin && (
                      <>
                        <button onClick={() => saveParamRow(row)} className="text-xs text-amber-400 hover:underline mr-3">Save</button>
                        <button onClick={() => deleteParamRow(row.id)} className="text-xs text-signal-red hover:underline">Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-end gap-3 pt-2 border-t border-base-800">
            <div>
              <label className="label">Feature key</label>
              <input type="text" value={newParam.feature_key} onChange={(e) => setNewParam({ ...newParam, feature_key: e.target.value })}
                className="input text-xs w-44 bg-base-950 border-base-700 text-ink-100" />
            </div>
            <div>
              <label className="label">Param ID</label>
              <input type="number" value={newParam.param_id} onChange={(e) => setNewParam({ ...newParam, param_id: e.target.value })}
                className="input text-xs w-24 bg-base-950 border-base-700 text-ink-100" />
            </div>
            <div>
              <label className="label">Description</label>
              <input type="text" value={newParam.description} onChange={(e) => setNewParam({ ...newParam, description: e.target.value })}
                className="input text-xs w-64 bg-base-950 border-base-700 text-ink-100" />
            </div>
            <button onClick={addParamRow} className="btn-primary text-xs px-4 py-2">Add mapping</button>
          </div>
        )}
      </div>
    </div>
  );
}
