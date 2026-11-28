import { useEffect, useMemo, useState } from "react";
import {
  reportsApi,
  type ReportFilters,
  type ReportOptions,
  type ReportResult,
  type ReportType,
} from "../api/reports";

function pgtInput(date: Date): string {
  return new Date(date.getTime() + 10 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function defaultFilters(): ReportFilters {
  const now = new Date();
  return {
    from: pgtInput(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
    to: pgtInput(now),
  };
}

function formatValue(value: unknown, format?: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "date") {
    const raw = String(value);
    const date = new Date(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
    return Number.isNaN(date.getTime())
      ? raw
      : date.toLocaleString("en-AU", { timeZone: "Pacific/Port_Moresby", hour12: false });
  }
  if (format === "number") return Number(value).toLocaleString();
  if (format === "decimal") return Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (format === "percent") return `${Number(value).toFixed(1)}%`;
  if (format === "currency") return `PGK ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return String(value);
}

const KPI_TONE: Record<string, string> = {
  default: "text-ink-100",
  good: "text-signal-green",
  warn: "text-amber-400",
  danger: "text-signal-red",
};

const REPORT_ICONS: Record<ReportType, string> = {
  "trip-mileage": "↗",
  "driver-behaviour": "⚡",
  "geofence-idle": "◎",
  "fuel-utilization": "⛽",
  "fuel-cards": "💳",
  "device-health": "◉",
};

export default function FleetReports() {
  const [options, setOptions] = useState<ReportOptions | null>(null);
  const [reportType, setReportType] = useState<ReportType>("trip-mileage");
  const [filters, setFilters] = useState<ReportFilters>(defaultFilters);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedVehicle = useMemo(
    () => options?.vehicles.find((vehicle) => vehicle.id === filters.vehicleId) ?? null,
    [options, filters.vehicleId]
  );

  useEffect(() => {
    reportsApi
      .options()
      .then((res) => setOptions(res.data))
      .catch((err: Error) => setError(err.message || "Failed to load report options"));
  }, []);

  useEffect(() => {
    void runReport(reportType, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runReport(type = reportType, nextFilters = filters) {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await reportsApi.run(type, nextFilters);
      setReport(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build report");
    } finally {
      setLoading(false);
    }
  }

  function chooseReport(type: ReportType) {
    setReportType(type);
    void runReport(type, filters);
  }

  function updateFilter(key: keyof ReportFilters, value: string) {
    setFilters((current) => {
      const next = { ...current, [key]: value };
      if (key === "vehicleId") {
        const vehicle = options?.vehicles.find((item) => item.id === value);
        next.imei = vehicle?.imei ?? "";
      }
      return next;
    });
  }

  async function downloadCsv() {
    setExporting(true);
    setError(null);
    try {
      const blob = await reportsApi.csv(reportType, filters);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${reportType}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV export failed");
    } finally {
      setExporting(false);
    }
  }

  async function emailReport() {
    setEmailing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await reportsApi.email(reportType, filters);
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Email delivery failed");
    } finally {
      setEmailing(false);
    }
  }

  const activeType = options?.report_types.find((item) => item.type === reportType);

  return (
    <div className="space-y-5">
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 no-print">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Fleet Reports</h1>
          <p className="text-sm text-ink-400 mt-1">
            Build operational reports by vehicle, IMEI, fleet group and Port Moresby time range.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button onClick={() => void runReport()} disabled={loading} className="btn-secondary text-xs px-4 py-2">
            {loading ? "Building…" : "Run report"}
          </button>
          <button onClick={() => void downloadCsv()} disabled={exporting || !report} className="btn-secondary text-xs px-4 py-2">
            {exporting ? "Exporting…" : "CSV"}
          </button>
          <button onClick={() => window.print()} disabled={!report} className="btn-secondary text-xs px-4 py-2">
            PDF / Print
          </button>
          <button onClick={() => void emailReport()} disabled={emailing || !report} className="btn-primary text-xs px-4 py-2">
            {emailing ? "Sending…" : "Email Report Now"}
          </button>
        </div>
      </div>

      <div className="hidden print:block">
        <h1 className="text-xl font-bold text-black">{report?.title ?? "Fleet Report"}</h1>
        <p className="text-sm text-black">
          {report?.period.fromPgt} to {report?.period.toPgt}
        </p>
      </div>

      {error && <div className="p-3 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}
      {message && <div className="p-3 rounded-lg bg-signal-green/10 text-signal-green text-sm">{message}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 no-print">
        {(options?.report_types ?? []).map((item) => (
          <button
            key={item.type}
            onClick={() => chooseReport(item.type)}
            className={`text-left p-4 rounded-lg border transition-colors ${
              reportType === item.type
                ? "border-amber-400 bg-amber-400/10"
                : "border-base-600 bg-base-800 hover:border-base-500"
            }`}
          >
            <div className="text-lg text-amber-400">{REPORT_ICONS[item.type]}</div>
            <div className="text-sm font-semibold text-ink-100 mt-1">{item.title}</div>
            <div className="text-[11px] text-ink-500 mt-1 leading-relaxed">{item.description}</div>
          </button>
        ))}
      </div>

      <div className="panel p-4 no-print">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3 items-end">
          <div>
            <label className="label">From (PGT)</label>
            <input
              type="datetime-local"
              className="input text-xs"
              value={filters.from ?? ""}
              onChange={(event) => updateFilter("from", event.target.value)}
            />
          </div>
          <div>
            <label className="label">To (PGT)</label>
            <input
              type="datetime-local"
              className="input text-xs"
              value={filters.to ?? ""}
              onChange={(event) => updateFilter("to", event.target.value)}
            />
          </div>
          <div>
            <label className="label">Vehicle</label>
            <select className="input text-xs" value={filters.vehicleId ?? ""} onChange={(event) => updateFilter("vehicleId", event.target.value)}>
              <option value="">All vehicles</option>
              {(options?.vehicles ?? []).map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.vehicle_number} · {vehicle.registration_number}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">IMEI</label>
            <input
              className="input text-xs font-mono"
              placeholder="Device IMEI"
              value={filters.imei ?? selectedVehicle?.imei ?? ""}
              onChange={(event) => updateFilter("imei", event.target.value)}
            />
          </div>
          <div>
            <label className="label">Fleet Group</label>
            <select className="input text-xs" value={filters.group ?? ""} onChange={(event) => updateFilter("group", event.target.value)}>
              <option value="">All groups</option>
              {(options?.groups ?? []).map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-[11px] text-ink-500">
          <span>{activeType?.title} · {report?.period.days ?? 0} day range · {options?.recipient ?? "fleet@dspng.tech"}</span>
          <button
            onClick={() => {
              const next = defaultFilters();
              setFilters(next);
              void runReport(reportType, next);
            }}
            className="text-amber-400 hover:text-amber-300"
          >
            Reset to last 7 days
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-10 text-center text-ink-400">Building report…</div>
      ) : !report ? (
        <div className="panel p-10 text-center text-ink-500">Choose a report and run it to see results.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {report.kpis.map((kpi) => (
              <div key={kpi.key} className="panel p-4">
                <div className="text-[10px] uppercase tracking-wide text-ink-500">{kpi.label}</div>
                <div className={`font-data text-2xl font-semibold mt-1 ${KPI_TONE[kpi.tone ?? "default"]}`}>{kpi.value}</div>
                {kpi.hint && <div className="text-[10px] text-ink-500 mt-1">{kpi.hint}</div>}
              </div>
            ))}
          </div>

          <div className="text-xs text-ink-500">
            {report.title} · {report.period.fromPgt} to {report.period.toPgt} · generated{" "}
            {new Date(report.generatedAt).toLocaleString("en-AU", { timeZone: "Pacific/Port_Moresby", hour12: false })}
          </div>

          {report.sections.map((section) => (
            <div key={section.key} className="panel overflow-hidden">
              <div className="px-5 py-3 border-b border-base-700 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-ink-100">{section.title}</div>
                <div className="text-[11px] text-ink-500">{section.rows.length} rows</div>
              </div>
              <div className="overflow-x-auto">
                <table className="table-shell">
                  <thead>
                    <tr>
                      {section.columns.map((column) => (
                        <th key={column.key} className="whitespace-nowrap">{column.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.length === 0 ? (
                      <tr>
                        <td colSpan={section.columns.length} className="text-center text-ink-500 py-8">
                          No rows for this period and filter.
                        </td>
                      </tr>
                    ) : (
                      section.rows.slice(0, 500).map((row, index) => (
                        <tr key={`${section.key}-${index}`}>
                          {section.columns.map((column) => {
                            const value = row[column.key];
                            if (column.key === "map_link" && value) {
                              return (
                                <td key={column.key}>
                                  <a href={String(value)} target="_blank" rel="noreferrer" className="text-amber-400 hover:text-amber-300 text-xs">
                                    Open map
                                  </a>
                                </td>
                              );
                            }
                            return (
                              <td key={column.key} className={column.format === "number" || column.format === "decimal" ? "font-data whitespace-nowrap" : "text-xs"}>
                                {formatValue(value, column.format)}
                              </td>
                            );
                          })}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {section.rows.length > 500 && (
                <div className="px-5 py-2 text-[11px] text-ink-500 border-t border-base-700">
                  Showing first 500 rows. Export CSV for the complete dataset.
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
