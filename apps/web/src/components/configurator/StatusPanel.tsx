import { useMemo, useState, type ReactNode } from "react";
import type { DeviceConfig } from "../../api/deviceConfig";
import type { DeviceCommand, DeviceFeatures } from "../../api/telemetry";

type DiagnosticCommand = "getinfo" | "getgps" | "getver" | "getstatus" | "getio";
type InfoBag = Record<string, string>;

const STATUS_TABS = [
  { key: "gnss", label: "GNSS Info" },
  { key: "gsm", label: "GSM Info" },
  { key: "io", label: "I/O Info" },
  { key: "maintenance", label: "Maintenance" },
] as const;

const COMMAND_STYLES: Record<string, string> = {
  queued: "bg-amber-400/15 text-amber-400",
  sent: "bg-signal-green/15 text-signal-green",
  applied: "bg-emerald-500/15 text-emerald-400",
  acked: "bg-emerald-500/15 text-emerald-400",
  acknowledged: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-signal-red/15 text-signal-red",
  expired: "bg-base-600 text-ink-300",
};

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function flatten(value: unknown, prefix: string, out: InfoBag): void {
  if (value === null || value === undefined) return;
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      out[prefix || "items"] = value.map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item))).join(", ");
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out[prefix || "value"] = String(value);
}

function parseKeyValues(text: string): InfoBag {
  const out: InfoBag = {};
  for (const match of text.matchAll(/([A-Za-z][A-Za-z0-9 _./-]{1,40})\s*[:=]\s*([^,;\n]+)/g)) {
    out[match[1].trim()] = match[2].trim();
  }
  return out;
}

function parseReply(value: unknown): InfoBag {
  const out: InfoBag = {};
  if (value === null || value === undefined) return out;
  const text = typeof value === "string" ? value.trim() : "";
  if (typeof value === "object") {
    flatten(value, "", out);
  } else if (text) {
    try {
      flatten(JSON.parse(text), "", out);
    } catch {
      Object.assign(out, parseKeyValues(text));
    }
  }
  // Bridge replies often wrap the tracker text as `{status, value}`.
  for (const [key, nested] of Object.entries(out)) {
    if (/^(value|reply|response|text|message|raw)$/i.test(key) && nested.includes(":")) {
      Object.assign(out, parseKeyValues(nested));
    }
  }
  if (Object.keys(out).length === 0 && text) out.reply = text;
  return out;
}

function buildInfoBag(config: DeviceConfig | null): InfoBag {
  const bag: InfoBag = {};
  const info = config?.device_info;
  if (!info) return bag;
  for (const kind of ["getinfo", "getstatus", "getgps", "getio"]) {
    Object.assign(bag, parseReply(info[kind]));
  }
  return bag;
}

function pick(bag: InfoBag, aliases: string[]): string | null {
  const normalized = aliases.map(normalizeKey);
  for (const [key, value] of Object.entries(bag)) {
    if (normalized.includes(normalizeKey(key)) && value !== "") return value;
  }
  for (const [key, value] of Object.entries(bag)) {
    const keyNorm = normalizeKey(key);
    if (normalized.some((alias) => keyNorm.endsWith(alias)) && value !== "") return value;
  }
  return null;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const hasZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(value);
  const date = new Date(hasZone ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function voltageMv(liveValue: number | null | undefined, bag: InfoBag, aliases: string[]): string {
  const reported = pick(bag, aliases);
  if (reported) return reported;
  return liveValue != null ? String(Math.round(liveValue * 1000)) : "—";
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className={`text-ink-100 text-xs break-words ${mono ? "font-mono" : ""}`}>{value || "—"}</div>
    </div>
  );
}

function StatusCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel p-4 space-y-3">
      <h3 className="text-xs font-bold text-ink-100 uppercase tracking-wider">{title}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-4 gap-4">{children}</div>
    </div>
  );
}

export default function StatusPanel({
  config,
  device,
  imei,
  online,
  commands,
  busy,
  canCommand,
  onDiagnostic,
  onReboot,
}: {
  config: DeviceConfig | null;
  device: DeviceFeatures | null;
  imei: string;
  online: boolean;
  commands: DeviceCommand[];
  busy: string | null;
  canCommand: boolean;
  onDiagnostic: (command: DiagnosticCommand) => void;
  onReboot: () => void;
}) {
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]["key"]>("gnss");
  const bag = useMemo(() => buildInfoBag(config), [config]);
  const live = device?.live ?? null;
  const model = config?.device_model ?? "FMB125";
  const firmware = config?.firmware_version ?? "—";

  const ioValue = (keys: string[]): string | null => {
    const normalized = keys.map(normalizeKey);
    const feature = device?.features.find((item) => {
      const featureKey = normalizeKey(item.feature_key);
      const label = normalizeKey(item.label);
      return normalized.some((key) => featureKey === key || featureKey.includes(key) || label.includes(key));
    });
    return feature?.value != null ? String(feature.value) : null;
  };

  const batteryMv = voltageMv(live?.int_battery_v, bag, ["internalbatteryvoltage", "batteryvoltage", "battery"]);
  const batteryStatus =
    pick(bag, ["internalbatterystatus", "batterystatus"]) ??
    (batteryMv !== "—" && Number(batteryMv) > 3500 ? "Good" : batteryMv !== "—" ? "Low" : "—");

  const visibleTotal =
    pick(bag, ["visibletotal", "totalinviewe", "satellitesvisible", "visible"]) ??
    (live?.sats != null ? String(live.sats) : "—");
  const inUseTotal =
    pick(bag, ["inuse", "satellitesinuse", "totalinuse", "used"]) ??
    (live?.sats != null ? String(live.sats) : "—");

  const diagnosticCommands = commands
    .filter((command) => command.command_type === "diagnostic" || command.command_type === "raw")
    .slice(0, 20);

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-ink-100 uppercase tracking-wider">Device Info</h3>
          <span className={`pill ${online ? "bg-emerald-500/15 text-emerald-400" : "bg-signal-red/15 text-signal-red"}`}>
            <span className={`beacon ${online ? "beacon-green" : "beacon-red"}`} />
            {online ? "Online" : "Offline"}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-5 gap-4">
          <Metric label="Device Name" value={`${model} DualSIM`} />
          <Metric label="Last Start Time" value={pick(bag, ["laststarttime", "starttime", "laststart"]) ?? "—"} />
          <Metric
            label="Power Voltage (mV)"
            value={voltageMv(live?.ext_voltage_v, bag, ["powervoltage", "externalvoltage", "extvoltage"])}
            mono
          />
          <Metric label="Ext Storage" value={pick(bag, ["extstorage", "externalstorage", "sdcard", "sdstatus"]) ?? "—"} />
          <Metric label="Battery Voltage (mV)" value={batteryMv} mono />
          <Metric label="Firmware Version" value={firmware} mono />
          <Metric label="RTC Time (UTC)" value={pick(bag, ["rtctime", "rtc", "devicetime"]) ?? "—"} mono />
          <Metric label="Device IMEI" value={imei} mono />
          <Metric label="Device Uptime" value={pick(bag, ["uptime", "deviceuptime", "runtime"]) ?? "—"} />
          <Metric label="Internal Battery Status" value={batteryStatus} />
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-base-700 pb-2">
        {STATUS_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
              tab === item.key ? "bg-amber-400/15 text-amber-400 font-semibold" : "text-ink-400 hover:bg-base-800 hover:text-ink-100"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "gnss" && (
        <div className="grid grid-cols-1 2xl:grid-cols-3 gap-4">
          <StatusCard title="GNSS Status">
            <Metric label="Module Status" value={pick(bag, ["modulestatus", "gnssstatus"]) ?? (online ? "ON" : "OFF")} />
            <Metric label="GNSS packets" value={pick(bag, ["gnsspackets", "packets", "packetcount"]) ?? "—"} />
            <Metric
              label="Fix Status"
              value={pick(bag, ["fixstatus", "gnssfix"]) ?? (live?.lat != null && live?.lon != null ? "3D Fix" : "No Fix")}
            />
            <Metric label="Fix Time" value={pick(bag, ["fixtime", "lastfix", "gpstime"]) ?? fmtDate(live?.recorded_at)} />
          </StatusCard>
          <StatusCard title="Location">
            <Metric
              label="Latitude"
              value={live?.lat != null ? live.lat.toFixed(6) : pick(bag, ["latitude", "lat"]) ?? "—"}
              mono
            />
            <Metric
              label="Longitude"
              value={live?.lon != null ? live.lon.toFixed(6) : pick(bag, ["longitude", "lon", "lng"]) ?? "—"}
              mono
            />
            <Metric label="Altitude" value={pick(bag, ["altitude", "alt"]) ?? "—"} />
            <Metric label="Speed" value={live?.speed_kmh != null ? `${live.speed_kmh} km/h` : pick(bag, ["speed"]) ?? "—"} />
            <Metric label="Angle" value={pick(bag, ["angle", "heading", "course"]) ?? "—"} />
            <Metric label="HDOP" value={pick(bag, ["hdop"]) ?? "—"} />
            <Metric label="PDOP" value={pick(bag, ["pdop"]) ?? "—"} />
          </StatusCard>
          <StatusCard title="Satellites">
            <Metric label="Visible: GPS" value={pick(bag, ["visiblegps", "gpsvisible", "gpsinviewe"]) ?? "—"} />
            <Metric label="Visible: GLONASS" value={pick(bag, ["visibleglonass", "glonassvisible"]) ?? "—"} />
            <Metric label="Visible: BeiDou" value={pick(bag, ["visiblebeidou", "beidouvisible"]) ?? "—"} />
            <Metric label="Visible: Galileo" value={pick(bag, ["visiblegalileo", "galileovisible"]) ?? "—"} />
            <Metric label="Total In View" value={visibleTotal} />
            <Metric label="In Use: GPS" value={pick(bag, ["inuseGps", "gpsinuse", "gpsused"]) ?? "—"} />
            <Metric label="In Use: GLONASS" value={pick(bag, ["inuseGlonass", "glonassInUse"]) ?? "—"} />
            <Metric label="In Use: BeiDou" value={pick(bag, ["inuseBeidou", "beidouInUse"]) ?? "—"} />
            <Metric label="In Use: Galileo" value={pick(bag, ["inuseGalileo", "galileoInUse"]) ?? "—"} />
            <Metric label="Satellites In Use" value={inUseTotal} />
          </StatusCard>
        </div>
      )}

      {tab === "gsm" && (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          <StatusCard title="GSM / GPRS">
            <Metric label="Operator" value={pick(bag, ["operator", "networkoperator", "gsmoperator"]) ?? "—"} />
            <Metric label="Signal Strength (RSSI)" value={pick(bag, ["rssi", "signalstrength", "signal"]) ?? "—"} />
            <Metric label="GPRS Status" value={pick(bag, ["gprsstatus", "gprs", "dataconnection"]) ?? "—"} />
            <Metric label="Socket Status" value={pick(bag, ["socketstatus", "socket", "linkstatus", "serverstatus"]) ?? "—"} />
            <Metric label="Network Registration" value={pick(bag, ["registration", "networkstatus", "creg"]) ?? "—"} />
          </StatusCard>
          <StatusCard title="SIM">
            <Metric label="SIM Info" value={pick(bag, ["siminfo", "simstatus", "sim"]) ?? "—"} />
            <Metric label="IMSI" value={pick(bag, ["imsi"]) ?? "—"} mono />
            <Metric label="ICCID" value={pick(bag, ["iccid"]) ?? "—"} mono />
            <Metric label="SIM Slot" value={pick(bag, ["simslot", "activesim"]) ?? "—"} />
            <Metric label="Roaming" value={pick(bag, ["roaming"]) ?? "—"} />
          </StatusCard>
        </div>
      )}

      {tab === "io" && (
        <StatusCard title="Digital / Analog I/O">
          <Metric label="DIN1" value={pick(bag, ["din1", "digitalinput1"]) ?? ioValue(["din1", "digital_input_1"]) ?? "—"} />
          <Metric label="DOUT1" value={pick(bag, ["dout1", "digitaloutput1"]) ?? ioValue(["dout1", "digital_output_1"]) ?? "—"} />
          <Metric label="AIN1" value={pick(bag, ["ain1", "analoginput1"]) ?? ioValue(["ain1", "analog_input_1"]) ?? "—"} />
          <Metric
            label="External Voltage"
            value={`${voltageMv(live?.ext_voltage_v, bag, ["externalvoltage", "extvoltage"])} mV`}
          />
          <Metric
            label="Battery Voltage"
            value={`${voltageMv(live?.int_battery_v, bag, ["internalbatteryvoltage", "batteryvoltage"])} mV`}
          />
          <Metric
            label="Ignition"
            value={live?.ignition === 1 ? "ON" : live?.ignition === 0 ? "OFF" : pick(bag, ["ignition"]) ?? "—"}
          />
        </StatusCard>
      )}

      {tab === "maintenance" && (
        <div className="space-y-4">
          <div className="panel p-4 space-y-3">
            <div>
              <h3 className="text-xs font-bold text-ink-100 uppercase tracking-wider">Quick Diagnostics</h3>
              <p className="text-[11px] text-ink-500 mt-1">
                Commands are queued through MeshSat and run on the tracker's next Codec 12 session.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(["getinfo", "getver", "getstatus", "getio"] as DiagnosticCommand[]).map((command) => (
                <button
                  key={command}
                  type="button"
                  onClick={() => onDiagnostic(command)}
                  disabled={!canCommand || busy !== null}
                  className="btn-secondary text-xs px-3 py-2 font-mono"
                >
                  {busy === command ? "Running…" : command}
                </button>
              ))}
              <button
                type="button"
                onClick={onReboot}
                disabled={!canCommand || busy !== null}
                className="bg-signal-red/20 hover:bg-signal-red/30 text-signal-red font-semibold px-3 py-2 rounded-md text-xs border border-signal-red/30 disabled:opacity-40 font-mono"
              >
                cpureset
              </button>
            </div>
            {!canCommand && (
              <p className="text-[11px] text-amber-300">Your role is read-only; diagnostic commands are disabled.</p>
            )}
          </div>

          <div className="panel overflow-hidden">
            <div className="px-4 py-3 border-b border-base-700 flex items-center justify-between gap-3">
              <h3 className="text-xs font-bold text-ink-100 uppercase tracking-wider">Live Command Output</h3>
              <span className="text-[10px] text-ink-500">{diagnosticCommands.length} recent</span>
            </div>
            <div className="overflow-x-auto">
              <table className="table-shell">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Command</th>
                    <th>Status</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnosticCommands.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-center text-ink-500 py-8">
                        No diagnostic commands yet.
                      </td>
                    </tr>
                  ) : (
                    diagnosticCommands.map((command) => (
                      <tr key={command.id}>
                        <td className="text-[11px] text-ink-400 whitespace-nowrap">{fmtDate(command.created_at)}</td>
                        <td className="text-[11px] font-mono text-amber-400">{command.raw_command ?? command.payload_json}</td>
                        <td>
                          <span className={`pill ${COMMAND_STYLES[command.status] ?? "bg-base-600 text-ink-300"}`}>
                            {command.status}
                          </span>
                        </td>
                        <td className="text-[11px] text-ink-400 max-w-[32rem] truncate" title={command.response_text ?? ""}>
                          {command.response_text ?? "Awaiting reply…"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {config?.device_info && (
            <div className="panel p-4">
              <h3 className="text-xs font-bold text-ink-100 uppercase tracking-wider mb-2">Latest Device Info Reply</h3>
              <pre className="text-[10px] font-mono text-ink-400 whitespace-pre-wrap break-all max-h-80 overflow-auto">
                {JSON.stringify(config.device_info, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
