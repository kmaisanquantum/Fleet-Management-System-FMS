import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  deviceConfigApi,
  DeviceConfig,
  DeviceConfigValue,
  DeviceSummary,
  TeltonikaField,
  TeltonikaRegistry,
  TeltonikaSection,
} from "../api/deviceConfig";
import { telemetryApi, DeviceCommand, DeviceFeatures } from "../api/telemetry";
import { useAuth } from "../context/AuthContext";

const COMMAND_ROLES = new Set(["admin", "fleet_manager"]);
const PROFILE_SCHEMA = "fms.teltonika.profile.v1";

const COMMAND_STATUS_STYLES: Record<string, string> = {
  queued: "bg-amber-400/15 text-amber-400",
  sent: "bg-signal-green/15 text-signal-green",
  applied: "bg-emerald-500/15 text-emerald-400",
  acked: "bg-emerald-500/15 text-emerald-400",
  acknowledged: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-signal-red/15 text-signal-red",
  expired: "bg-base-600 text-ink-300",
};

const CONFIG_STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-400/15 text-amber-400",
  applied: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-signal-red/15 text-signal-red",
  unknown: "bg-base-600 text-ink-300",
};

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const hasZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(value);
  const normalized = hasZone ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function stateMap(config: DeviceConfig | null) {
  const map = new Map<number, DeviceConfig["parameter_states"][number]>();
  for (const state of config?.parameter_states ?? []) map.set(state.param_id, state);
  return map;
}

/** PostgreSQL returns JSONB values as numbers/booleans; form inputs need strings. */
function asInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function valuesForRegistry(
  registry: TeltonikaRegistry | null,
  config: DeviceConfig | null
): Record<string, string> {
  const states = stateMap(config);
  const values: Record<string, string> = {};
  const fields = registry?.sections.flatMap((s) => [...s.fields, ...(s.features ?? []).flatMap((f) => f.fields)]) ?? [];
  for (const field of fields) {
    const state = states.get(field.paramId);
    // Compare edits against the last applied value, not a pending/failed
    // desired value, so a rejected write stays visible as "modified" for retry.
    values[field.id] = asInputValue(state?.applied_value ?? field.defaultValue);
  }
  return values;
}

function coerceValue(field: TeltonikaField, raw: string): DeviceConfigValue {
  if (field.type === "number" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

function validateField(field: TeltonikaField, raw: string): string | null {
  if (raw === "") return null;
  if (field.type === "number") {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return `${field.label} must be a number`;
    if (field.min !== undefined && numeric < field.min) return `${field.label} must be at least ${field.min}`;
    if (field.max !== undefined && numeric > field.max) return `${field.label} must be at most ${field.max}`;
  }
  return null;
}

function sectionFields(section: TeltonikaSection): TeltonikaField[] {
  return [...section.fields, ...(section.features ?? []).flatMap((f) => f.fields)];
}

function FieldControl({
  field,
  value,
  initialValue,
  stateStatus,
  desiredValue,
  disabled,
  onChange,
}: {
  field: TeltonikaField;
  value: string;
  initialValue: string;
  stateStatus: string | undefined;
  desiredValue: string | null | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const dirty = value !== initialValue;
  const common = "input text-xs w-full bg-base-900 border-base-700 text-ink-100 disabled:opacity-60";
  return (
    <div className={`min-w-0 space-y-1 ${field.dangerous ? "rounded-md border border-amber-400/20 bg-amber-400/[0.03] p-2" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <label className="label mb-0 truncate" title={field.label}>
          {field.label}
        </label>
        <div className="flex items-center gap-1 shrink-0">
          {dirty && <span className="pill bg-amber-400/15 text-amber-400">modified</span>}
          <span className={`pill ${CONFIG_STATUS_STYLES[stateStatus ?? "unknown"]}`}>{stateStatus ?? "not loaded"}</span>
        </div>
      </div>

      {field.type === "select" || field.type === "boolean" ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={common}>
          <option value="">— not loaded —</option>
          {(field.options ?? [
            { value: "0", label: "Disable" },
            { value: "1", label: "Enable" },
          ]).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="relative">
          <input
            type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
            value={value}
            min={field.min}
            max={field.max}
            step={field.step}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className={`${common} ${field.unit ? "pr-14" : ""}`}
          />
          {field.unit && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ink-500">{field.unit}</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-500 font-mono">
        <span>ID {field.paramId}</span>
        {field.unit && <span>· {field.unit}</span>}
        {field.dangerous && <span className="text-amber-400">· dangerous</span>}
        {stateStatus === "failed" && desiredValue != null && desiredValue !== "" && (
          <span className="text-signal-red">· last requested {String(desiredValue)}</span>
        )}
      </div>
      {field.help && <p className="text-[10px] text-ink-500 leading-snug">{field.help}</p>}
    </div>
  );
}

function FeatureCard({
  title,
  description,
  fields,
  form,
  initial,
  states,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  fields: TeltonikaField[];
  form: Record<string, string>;
  initial: Record<string, string>;
  states: Map<number, DeviceConfig["parameter_states"][number]>;
  disabled: boolean;
  onChange: (fieldId: string, value: string) => void;
}) {
  return (
    <div className="panel p-4 space-y-3 min-w-0">
      <div>
        <h3 className="text-sm font-bold text-ink-100">{title}</h3>
        <p className="text-[11px] text-ink-500 mt-0.5">{description}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {fields.map((field) => (
          <FieldControl
            key={field.id}
            field={field}
            value={form[field.id] ?? ""}
            initialValue={initial[field.id] ?? ""}
            stateStatus={states.get(field.paramId)?.status}
            desiredValue={states.get(field.paramId)?.desired_value}
            disabled={disabled}
            onChange={(value) => onChange(field.id, value)}
          />
        ))}
      </div>
    </div>
  );
}

export default function DeviceConfigurator() {
  const { imei: routeImei } = useParams<{ imei: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCommand = !!user && COMMAND_ROLES.has(user.role);
  const isAdmin = user?.role === "admin";

  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [registry, setRegistry] = useState<TeltonikaRegistry | null>(null);
  const [config, setConfig] = useState<DeviceConfig | null>(null);
  const [device, setDevice] = useState<DeviceFeatures | null>(null);
  const [commands, setCommands] = useState<DeviceCommand[]>([]);
  const [activeSection, setActiveSection] = useState("features");
  const [form, setForm] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const initialRef = useRef<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [reason, setReason] = useState("Configurator change");
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [rebootAcknowledged, setRebootAcknowledged] = useState(false);
  const [rebootReason, setRebootReason] = useState("Remote reboot requested from Configurator");
  const [rawParamId, setRawParamId] = useState("");
  const [rawValue, setRawValue] = useState("");
  const [rawRead, setRawRead] = useState("");
  const [latestRecord, setLatestRecord] = useState<Record<string, unknown> | null>(null);
  const [showHistory, setShowHistory] = useState(true);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "polling">("polling");
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const allFields = useMemo(
    () => registry?.sections.flatMap((section) => sectionFields(section)) ?? [],
    [registry]
  );
  const states = useMemo(() => stateMap(config), [config]);
  const dirtyFields = useMemo(
    () => allFields.filter((field) => (form[field.id] ?? "") !== (initial[field.id] ?? "")),
    [allFields, form, initial]
  );
  const active = useMemo(
    () => registry?.sections.find((section) => section.key === activeSection) ?? registry?.sections[0],
    [registry, activeSection]
  );
  const currentDevice = devices.find((item) => item.imei === routeImei);
  const online = config?.online ?? device?.online ?? currentDevice?.online ?? false;

  const loadRegistry = useCallback(async () => {
    try {
      const [registryRes, devicesRes] = await Promise.all([
        deviceConfigApi.registry(),
        deviceConfigApi.list().catch(() => ({ data: [] as DeviceSummary[] })),
      ]);
      setRegistry(registryRes.data);
      setDevices(devicesRes.data);
    } catch (err: any) {
      setError(err.message || "Failed to load Teltonika registry");
    }
  }, []);

  const loadDevice = useCallback(async () => {
    if (!routeImei) return;
    try {
      const [configRes, featuresRes, commandsRes] = await Promise.all([
        deviceConfigApi.get(routeImei),
        telemetryApi.features(routeImei).catch(() => null),
        telemetryApi.commands.list(routeImei).catch(() => ({ data: [] as DeviceCommand[] })),
      ]);
      const nextConfig = configRes.data;
      setConfig(nextConfig);
      setDevice(featuresRes?.data ?? null);
      setCommands(commandsRes.data);
      setLastRefresh(new Date());
      setError(null);

      const nextInitial = valuesForRegistry(registry, nextConfig);
      const previous = initialRef.current;
      setForm((current) => {
        const next = { ...current };
        for (const field of allFields) {
          const oldValue = previous[field.id];
          const newValue = nextInitial[field.id] ?? "";
          if (next[field.id] === undefined || next[field.id] === oldValue) next[field.id] = newValue;
        }
        return next;
      });
      initialRef.current = nextInitial;
      setInitial(nextInitial);
    } catch (err: any) {
      setError(err.message || "Failed to load device configuration");
    } finally {
      setLoading(false);
    }
  }, [routeImei, registry, allFields]);

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  useEffect(() => {
    if (!registry) return;
    loadDevice();
    const interval = setInterval(loadDevice, 5000);
    return () => clearInterval(interval);
  }, [loadDevice, registry]);

  useEffect(() => {
    if (!routeImei) return;
    const controller = new AbortController();
    let active = true;
    setStreamState("connecting");
    deviceConfigApi
      .stream(routeImei, controller.signal, () => {
        if (!active) return;
        setStreamState("live");
        loadDevice();
      })
      .catch(() => {
        if (active) setStreamState("polling");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [routeImei, loadDevice]);

  function setField(fieldId: string, value: string) {
    setForm((current) => ({ ...current, [fieldId]: value }));
  }

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    setImportMessage(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await loadDevice();
    } catch (err: any) {
      setError(err.message || `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  async function loadFromDevice() {
    if (!routeImei || !registry) return;
    await run("load", async () => {
      const res = await deviceConfigApi.load(routeImei, {
        param_ids: registry.load_param_ids,
        reason: reason.trim() || "Configurator load from device",
      });
      return res.message;
    });
  }

  async function saveToDevice() {
    if (!routeImei) return;
    const dirty = dirtyFields.filter((field) => (form[field.id] ?? "").trim() !== "");
    if (dirty.length === 0) {
      setNotice("No modified fields to save.");
      return;
    }
    for (const field of dirty) {
      const fieldError = validateField(field, form[field.id] ?? "");
      if (fieldError) {
        setError(fieldError);
        return;
      }
    }

    const byParam = new Map<number, DeviceConfigValue>();
    for (const field of dirty) byParam.set(field.paramId, coerceValue(field, form[field.id] ?? ""));

    await run("save", async () => {
      const res = await deviceConfigApi.update(routeImei, {
        parameters: [...byParam.entries()].map(([param_id, value]) => ({ param_id, value })),
        reason: reason.trim() || "Configurator save to device",
      });
      return `${res.message} ${byParam.size} parameter(s) differ from the last applied state.`;
    });
  }

  async function readRecords() {
    if (!routeImei) return;
    await run("records", async () => {
      const res = await deviceConfigApi.readRecords(routeImei, {
        reason: reason.trim() || "Configurator read records",
      });
      setLatestRecord(res.data.latest_record);
      return res.message;
    });
  }

  async function rebootDevice() {
    if (!routeImei) return;
    await run("reboot", async () => {
      const res = await deviceConfigApi.reboot(routeImei, {
        confirm: true,
        reason: rebootReason.trim() || "Remote reboot requested from Configurator",
      });
      setConfirmReboot(false);
      setRebootAcknowledged(false);
      return res.message;
    });
  }

  async function advancedRead() {
    if (!routeImei) return;
    const paramId = Number(rawRead);
    if (!Number.isInteger(paramId) || paramId <= 0) {
      setError("Enter a positive parameter ID to read.");
      return;
    }
    await run("advanced-read", async () => {
      const res = await deviceConfigApi.update(routeImei, {
        read: [paramId],
        reason: reason.trim() || "Advanced getparam",
      });
      return res.message;
    });
  }

  async function advancedWrite() {
    if (!routeImei) return;
    const paramId = Number(rawParamId);
    if (!Number.isInteger(paramId) || paramId <= 0) {
      setError("Enter a positive parameter ID to write.");
      return;
    }
    if (!rawValue.trim()) {
      setError("Enter a value to write.");
      return;
    }
    const numeric = Number(rawValue);
    const value: DeviceConfigValue = Number.isFinite(numeric) && rawValue.trim() !== "" ? numeric : rawValue;
    await run("advanced-write", async () => {
      const res = await deviceConfigApi.update(routeImei, {
        parameters: [{ param_id: paramId, value }],
        reason: reason.trim() || "Advanced setparam",
      });
      return res.message;
    });
  }

  function saveToFile() {
    if (!routeImei || !registry) return;
    const values = allFields
      .filter((field) => (form[field.id] ?? "").trim() !== "")
      .map((field) => ({
        field_id: field.id,
        param_id: field.paramId,
        label: field.label,
        section: field.category,
        value: form[field.id],
      }));
    const profile = {
      schema: PROFILE_SCHEMA,
      model: registry.model,
      imei: routeImei,
      exported_at: new Date().toISOString(),
      firmware_version: config?.firmware_version ?? null,
      config_version: config?.config_version ?? null,
      values,
    };
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `teltonika-${routeImei}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice(`Saved ${values.length} parameter value(s) to file.`);
  }

  async function loadFromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !registry) return;
    setError(null);
    setImportMessage(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        schema?: string;
        values?: { field_id?: string; param_id?: number; value?: string | number | boolean }[];
        parameters?: Record<string, string | number | boolean>;
      };
      if (parsed.schema && parsed.schema !== PROFILE_SCHEMA) {
        throw new Error(`Unsupported profile schema: ${parsed.schema}`);
      }
      const fieldsById = new Map(allFields.map((field) => [field.id, field]));
      const fieldsByParam = new Map(allFields.map((field) => [field.paramId, field]));
      const next: Record<string, string> = {};
      const rows = parsed.values ?? [];
      for (const row of rows) {
        const field = row.field_id ? fieldsById.get(row.field_id) : row.param_id ? fieldsByParam.get(row.param_id) : undefined;
        if (!field) continue;
        next[field.id] = row.value === undefined || row.value === null ? "" : String(row.value);
      }
      for (const [key, value] of Object.entries(parsed.parameters ?? {})) {
        const numeric = Number(key);
        const field = Number.isInteger(numeric) ? fieldsByParam.get(numeric) : fieldsById.get(key);
        if (field) next[field.id] = value === null || value === undefined ? "" : String(value);
      }
      if (Object.keys(next).length === 0) throw new Error("No recognised parameters found in this profile.");
      setForm((current) => ({ ...current, ...next }));
      setImportMessage(
        `Loaded ${Object.keys(next).length} value(s) from ${file.name}. Review the modified badges, then choose Save to device.`
      );
    } catch (err: any) {
      setError(err.message || "Failed to read profile file");
    }
  }

  if (loading && !registry) {
    return <div className="p-8 text-ink-400">Loading Teltonika Configurator…</div>;
  }

  if (!routeImei) {
    return <div className="p-8 text-ink-400">Choose a device IMEI from the vehicle telemetry page.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-amber-400/80 font-semibold">Remote Device Configuration</div>
          <h1 className="text-2xl font-bold text-ink-100">Teltonika Configurator</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/telemetry/device/${encodeURIComponent(routeImei)}`} className="btn-secondary text-xs px-3 py-2">
            Device Telemetry
          </Link>
          <Link to="/telemetry" className="btn-secondary text-xs px-3 py-2">
            Live Status
          </Link>
        </div>
      </div>

      <div className="panel p-4 space-y-4">
        <div className="flex flex-col 2xl:flex-row 2xl:items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-mono px-2 py-1 rounded bg-amber-400/15 text-amber-400 font-semibold">
                {config?.device_model ?? registry?.model ?? "FMB125"}
              </span>
              <select
                value={routeImei}
                onChange={(e) => navigate(`/telemetry/device/${encodeURIComponent(e.target.value)}/configurator`)}
                className="input text-xs font-mono w-auto min-w-[15rem] max-w-full bg-base-900 border-base-700 text-ink-100"
                aria-label="Select device IMEI"
              >
                {!currentDevice && <option value={routeImei}>{routeImei}</option>}
                {devices.map((item) => (
                  <option key={item.imei} value={item.imei}>
                    {item.vehicle_number ? `${item.vehicle_number} · ` : ""}
                    {item.imei}
                  </option>
                ))}
              </select>
              <span className={`pill ${online ? "bg-emerald-500/15 text-emerald-400" : "bg-signal-red/15 text-signal-red"}`}>
                <span className={`beacon ${online ? "beacon-green" : "beacon-red"}`} />
                {online ? "Online" : "Offline"}
              </span>
              <span className="text-[11px] text-ink-400">
                Last seen {fmtDate(config?.device_last_seen_at ?? currentDevice?.last_seen_at)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-400">
              <span>
                IMEI <span className="font-mono text-ink-200">{routeImei}</span>
              </span>
              <span>
                Vehicle <span className="text-ink-200">{config?.vehicle_number ?? currentDevice?.vehicle_number ?? "—"}</span>
              </span>
              <span>
                Firmware <span className="font-mono text-ink-200">{config?.firmware_version ?? currentDevice?.firmware_version ?? "—"}</span>
              </span>
              <span>
                Configuration <span className="font-mono text-ink-200">{config?.config_version ?? "—"}</span>
              </span>
              <span>
                {config?.queued_count ?? 0} queued · {dirtyFields.length} modified
              </span>
            </div>
            <div className="text-[10px] text-ink-500">
              {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()} · ` : ""}
              {streamState === "live" ? "live stream connected" : "live polling every 5s"}
              {config?.last_sync_info && config.last_sync_info !== "{}" && config.last_sync_info !== "null"
                ? ` · last device info: ${config.last_sync_info}`
                : ""}
            </div>
          </div>

          <div className="flex flex-col gap-2 min-w-0">
            <div className="flex flex-wrap gap-2">
              <button onClick={loadFromDevice} disabled={!canCommand || busy !== null} className="btn-secondary text-xs px-3 py-2">
                {busy === "load" ? "Loading…" : "Load from device"}
              </button>
              <button
                onClick={saveToDevice}
                disabled={!canCommand || busy !== null || dirtyFields.length === 0}
                className="btn-primary text-xs px-3 py-2"
              >
                {busy === "save" ? "Saving…" : `Save to device (${dirtyFields.length})`}
              </button>
              <button onClick={readRecords} disabled={!canCommand || busy !== null} className="btn-secondary text-xs px-3 py-2">
                Read records
              </button>
              <button
                onClick={() => {
                  setConfirmReboot(true);
                  setRebootAcknowledged(false);
                }}
                disabled={!canCommand || busy !== null}
                className="bg-signal-red/20 hover:bg-signal-red/30 text-signal-red font-semibold px-3 py-2 rounded-md text-xs border border-signal-red/30 disabled:opacity-40"
              >
                Reboot device
              </button>
              <button onClick={saveToFile} className="btn-secondary text-xs px-3 py-2">
                Save to file
              </button>
              <label className="btn-secondary text-xs px-3 py-2 cursor-pointer">
                Load from file
                <input type="file" accept="application/json,.json" onChange={loadFromFile} className="hidden" />
              </label>
            </div>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Change reason (audit log)"
              className="input text-xs w-full 2xl:w-80 bg-base-900 border-base-700 text-ink-100"
            />
          </div>
        </div>

        {!canCommand && (
          <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-2 text-[11px] text-amber-300">
            Your role is read-only. You can inspect loaded values and export a profile, but cannot write or reboot.
          </div>
        )}
      </div>

      {error && <div className="p-4 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}
      {notice && <div className="p-4 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">{notice}</div>}
      {importMessage && <div className="p-4 rounded-lg bg-amber-400/10 text-amber-400 text-sm">{importMessage}</div>}

      <div className="flex flex-col xl:flex-row gap-4">
        <aside className="panel xl:w-60 shrink-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] overflow-y-auto">
          <div className="px-3 py-3 border-b border-base-700 text-[10px] uppercase tracking-widest text-ink-500">
            Configurator Sections
          </div>
          <nav className="p-2 space-y-0.5">
            {registry?.sections.map((section) => (
              <button
                key={section.key}
                onClick={() => setActiveSection(section.key)}
                className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors border-l-2 ${
                  active?.key === section.key
                    ? "border-amber-400 bg-base-700/70 text-ink-100 font-semibold"
                    : "border-transparent text-ink-400 hover:bg-base-700/40 hover:text-ink-100"
                }`}
              >
                <span className="block truncate">{section.label}</span>
                <span className="block text-[9px] text-ink-500 mt-0.5 truncate">{section.kind === "status" ? "Read-only" : `${sectionFields(section).length} fields`}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex-1 min-w-0 space-y-4">
          {active && (
            <div className="panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-ink-100 uppercase tracking-wider">{active.label}</h2>
                  <p className="text-[11px] text-ink-500 mt-0.5">{active.description}</p>
                </div>
                {active.key === "gprs" && (
                  <div className="max-w-xl rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-[11px] text-amber-300">
                    Warning: APN, server, port, and protocol changes can disconnect this tracker from MeshSat. Confirm the
                    new values before saving; recovery may require physical access.
                  </div>
                )}
              </div>
            </div>
          )}

          {active?.key === "status" && (
            <div className="space-y-4">
              <div className="panel p-4">
                <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider mb-3">Device Identity</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-4 text-xs">
                  {[
                    ["Model", config?.device_model ?? registry?.model ?? "—"],
                    ["IMEI", routeImei],
                    ["Firmware", config?.firmware_version ?? "—"],
                    ["Configuration version", config?.config_version ?? "—"],
                    ["Vehicle", config?.vehicle_number ?? currentDevice?.vehicle_number ?? "—"],
                    ["Registration", config?.registration_number ?? currentDevice?.registration_number ?? "—"],
                    ["Last seen", fmtDate(config?.device_last_seen_at)],
                    ["Last applied", fmtDate(config?.last_applied_at)],
                    ["Device info updated", fmtDate(config?.device_info_updated_at)],
                    ["Registry parameters", String(config?.registry_param_count ?? registry?.field_count ?? "—")],
                  ].map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <div className="text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
                      <div className="text-ink-100 font-mono break-all">{value}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel p-4">
                <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider mb-3">Latest AVL State</h3>
                {device?.live ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-5 gap-4 text-xs">
                    {[
                      ["Recorded", fmtDate(device.live.recorded_at)],
                      ["Speed", device.live.speed_kmh != null ? `${device.live.speed_kmh} km/h` : "—"],
                      ["Ignition", device.live.ignition === 1 ? "ON" : "OFF"],
                      ["Movement", device.live.movement === 1 ? "Moving" : "Stationary"],
                      ["Satellites", device.live.sats != null ? String(device.live.sats) : "—"],
                      ["Fuel", device.live.fuel_liters != null ? `${device.live.fuel_liters} L` : "—"],
                      ["External voltage", device.live.ext_voltage_v != null ? `${device.live.ext_voltage_v} V` : "—"],
                      ["Internal battery", device.live.int_battery_v != null ? `${device.live.int_battery_v} V` : "—"],
                      ["Odometer", device.live.odometer_km != null ? `${device.live.odometer_km} km` : "—"],
                      ["Position", device.live.lat != null && device.live.lon != null ? `${device.live.lat.toFixed(5)}, ${device.live.lon.toFixed(5)}` : "No fix"],
                    ].map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <div className="text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
                        <div className="text-ink-100 break-words">{value}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-ink-500">No AVL record received yet.</p>
                )}
                {latestRecord && (
                  <div className="mt-3 rounded-md bg-base-950 border border-base-800 p-3 text-[10px] font-mono text-ink-400 overflow-x-auto">
                    {JSON.stringify(latestRecord, null, 2)}
                  </div>
                )}
              </div>

              <div className="panel p-4">
                <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider mb-3">Last Device Replies</h3>
                <pre className="text-[10px] font-mono text-ink-400 whitespace-pre-wrap break-all max-h-80 overflow-auto">
                  {JSON.stringify(config?.device_info ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {active?.key === "features" && (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
              {active.features?.map((feature) => (
                <FeatureCard
                  key={feature.key}
                  title={feature.label}
                  description={feature.description}
                  fields={feature.fields}
                  form={form}
                  initial={initial}
                  states={states}
                  disabled={!canCommand || busy !== null}
                  onChange={setField}
                />
              ))}
            </div>
          )}

          {active && active.key !== "status" && active.key !== "features" && active.features && active.features.length > 0 && (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
              {active.features.map((feature) => (
                <FeatureCard
                  key={feature.key}
                  title={feature.label}
                  description={feature.description}
                  fields={feature.fields}
                  form={form}
                  initial={initial}
                  states={states}
                  disabled={!canCommand || busy !== null}
                  onChange={setField}
                />
              ))}
            </div>
          )}

          {active && active.key !== "status" && active.key !== "features" && (!active.features || active.features.length === 0) && (
            <div className="space-y-4">
              {Array.from(new Set(active.fields.map((field) => field.subSection))).map((subSection) => (
                <div key={subSection} className="panel p-4">
                  <h3 className="text-xs font-bold text-ink-100 uppercase tracking-wider mb-3">{subSection}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
                    {active.fields
                      .filter((field) => field.subSection === subSection)
                      .map((field) => (
                        <FieldControl
                          key={field.id}
                          field={field}
                          value={form[field.id] ?? ""}
                          initialValue={initial[field.id] ?? ""}
                          stateStatus={states.get(field.paramId)?.status}
                          desiredValue={states.get(field.paramId)?.desired_value}
                          disabled={!canCommand || busy !== null}
                          onChange={(value) => setField(field.id, value)}
                        />
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="panel p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Raw / Advanced Parameter ID Override</h3>
                <p className="text-[11px] text-ink-500 mt-0.5">
                  Direct Codec 12 testing. Values are sent as `setparam &lt;id&gt;:&lt;value&gt;`; reads use `getparam &lt;id&gt;`.
                </p>
              </div>
              {!isAdmin && <span className="text-[10px] text-ink-500">Admin and fleet manager roles can use this section.</span>}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-md bg-base-950 border border-base-800 p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-ink-500">getparam</div>
                <div className="flex gap-2">
                  <input
                    value={rawRead}
                    onChange={(e) => setRawRead(e.target.value)}
                    placeholder="Parameter ID"
                    className="input text-xs bg-base-900 border-base-700 text-ink-100"
                  />
                  <button onClick={advancedRead} disabled={!canCommand || busy !== null} className="btn-secondary text-xs px-3 whitespace-nowrap">
                    Read
                  </button>
                </div>
              </div>
              <div className="rounded-md bg-base-950 border border-base-800 p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-ink-500">setparam</div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={rawParamId}
                    onChange={(e) => setRawParamId(e.target.value)}
                    placeholder="Parameter ID"
                    className="input text-xs bg-base-900 border-base-700 text-ink-100 sm:w-32"
                  />
                  <input
                    value={rawValue}
                    onChange={(e) => setRawValue(e.target.value)}
                    placeholder="Value"
                    className="input text-xs bg-base-900 border-base-700 text-ink-100"
                  />
                  <button onClick={advancedWrite} disabled={!canCommand || busy !== null} className="btn-primary text-xs px-3 whitespace-nowrap">
                    Write
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="panel overflow-hidden">
            <button
              onClick={() => setShowHistory((value) => !value)}
              className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left"
            >
              <span className="text-sm font-semibold text-ink-100">Command History &amp; Queue</span>
              <span className="text-[10px] text-ink-500">
                {config?.queued_count ? `${config.queued_count} queued` : "No queued commands"} · {showHistory ? "hide" : "show"}
              </span>
            </button>
            {showHistory && (
              <div className="overflow-x-auto border-t border-base-700">
                <table className="table-shell">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Type</th>
                      <th>Command</th>
                      <th>Status</th>
                      <th>Response</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {commands.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center text-ink-500 py-8">
                          No commands issued for this device.
                        </td>
                      </tr>
                    ) : (
                      commands.map((command) => (
                        <tr key={command.id}>
                          <td className="text-[11px] text-ink-400 whitespace-nowrap">{fmtDate(command.created_at)}</td>
                          <td className="text-xs text-ink-200">{command.command_type}</td>
                          <td className="text-[11px] font-mono text-amber-400 max-w-[16rem] truncate" title={command.raw_command ?? command.payload_json}>
                            {command.raw_command ?? command.payload_json}
                          </td>
                          <td>
                            <span className={`pill ${COMMAND_STATUS_STYLES[command.status] ?? "bg-base-600 text-ink-300"}`}>
                              {command.status}
                            </span>
                          </td>
                          <td className="text-[11px] text-ink-400 max-w-[20rem] truncate" title={command.response_text ?? ""}>
                            {command.response_text ?? "—"}
                          </td>
                          <td className="text-[11px] text-ink-400 max-w-[14rem] truncate" title={command.reason ?? ""}>
                            {command.reason ?? "—"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      {confirmReboot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="panel max-w-lg w-full p-5 space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-signal-red font-semibold">Dangerous action</div>
              <h2 className="text-lg font-bold text-ink-100">Reboot {routeImei}?</h2>
              <p className="text-xs text-ink-400 mt-1">
                This queues `cpureset` through MeshSat. The tracker restarts on its next sync and will be offline briefly.
              </p>
            </div>
            <label className="flex items-start gap-2 text-xs text-ink-300">
              <input
                type="checkbox"
                checked={rebootAcknowledged}
                onChange={(e) => setRebootAcknowledged(e.target.checked)}
                className="mt-0.5"
              />
              I understand the device will restart and telemetry will pause.
            </label>
            <input
              value={rebootReason}
              onChange={(e) => setRebootReason(e.target.value)}
              placeholder="Reason (stored in audit log)"
              className="input text-xs bg-base-900 border-base-700 text-ink-100"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setConfirmReboot(false);
                  setRebootAcknowledged(false);
                }}
                className="btn-secondary text-xs px-3 py-2"
              >
                Cancel
              </button>
              <button
                onClick={rebootDevice}
                disabled={!rebootAcknowledged || busy !== null}
                className="bg-signal-red/20 hover:bg-signal-red/30 text-signal-red font-semibold px-3 py-2 rounded-md text-xs border border-signal-red/30 disabled:opacity-40"
              >
                {busy === "reboot" ? "Rebooting…" : "Confirm reboot"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
