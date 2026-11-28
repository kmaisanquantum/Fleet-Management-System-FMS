import { db } from "../db";
import { getBusinessRule, getBusinessRuleBoolean } from "../routes/settings";
import { sendReportEmail } from "./email";
import { buildReport, REPORT_TYPES, reportToCsv, reportToHtml, reportToText } from "./reporting";

const PGT_OFFSET_MS = 10 * 60 * 60 * 1000;

interface PgtNow {
  date: string;
  minutes: number;
  weekday: number;
  dayOfMonth: number;
}

function pgtNow(now = new Date()): PgtNow {
  const pgt = new Date(now.getTime() + PGT_OFFSET_MS);
  return {
    date: pgt.toISOString().slice(0, 10),
    minutes: pgt.getUTCHours() * 60 + pgt.getUTCMinutes(),
    weekday: pgt.getUTCDay(),
    dayOfMonth: pgt.getUTCDate(),
  };
}

function pgtDate(date: Date): string {
  return new Date(date.getTime() + PGT_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 7 * 60;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return hours * 60 + minutes;
}

function alreadySentToday(reportType: string, todayPgt: string): boolean {
  const rows = db.prepare(`
    SELECT created_at FROM email_deliveries
    WHERE kind = 'scheduled_report' AND (report_type = ? OR report_type LIKE ?)
    ORDER BY created_at DESC LIMIT 5
  `).all(reportType, `${reportType}-%`) as { created_at: string }[];
  return rows.some((row) => {
    const raw = row.created_at;
    const date = new Date(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
    return !Number.isNaN(date.getTime()) && pgtDate(date) === todayPgt;
  });
}

function schedulePeriod(kind: "daily" | "weekly" | "monthly", now: Date): { from: string; to: string; label: string } {
  const todayPgt = new Date(now.getTime() + PGT_OFFSET_MS);
  if (kind === "daily") {
    const yesterday = addDays(todayPgt, -1);
    const date = yesterday.toISOString().slice(0, 10);
    return { from: `${date}T00:00`, to: `${date}T23:59`, label: `${date} (PGT)` };
  }
  if (kind === "weekly") {
    const end = addDays(todayPgt, -1);
    const start = addDays(end, -6);
    return {
      from: `${start.toISOString().slice(0, 10)}T00:00`,
      to: `${end.toISOString().slice(0, 10)}T23:59`,
      label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} (PGT)`,
    };
  }
  const firstOfThisMonth = new Date(Date.UTC(todayPgt.getUTCFullYear(), todayPgt.getUTCMonth(), 1));
  const lastOfPreviousMonth = addDays(firstOfThisMonth, -1);
  const firstOfPreviousMonth = new Date(Date.UTC(lastOfPreviousMonth.getUTCFullYear(), lastOfPreviousMonth.getUTCMonth(), 1));
  return {
    from: `${firstOfPreviousMonth.toISOString().slice(0, 10)}T00:00`,
    to: `${lastOfPreviousMonth.toISOString().slice(0, 10)}T23:59`,
    label: `${firstOfPreviousMonth.toISOString().slice(0, 10)} to ${lastOfPreviousMonth.toISOString().slice(0, 10)} (PGT)`,
  };
}

async function dispatchSchedule(kind: "daily" | "weekly" | "monthly", now: Date): Promise<boolean> {
  const enabled = getBusinessRuleBoolean(`report_${kind}_enabled`, undefined, true);
  if (!enabled) return false;

  const current = pgtNow(now);
  if (kind === "weekly" && current.weekday !== 1) return false;
  if (kind === "monthly" && current.dayOfMonth !== 1) return false;

  const time = getBusinessRule(`report_${kind}_time_pgt`, undefined, "07:00");
  if (current.minutes < parseTime(time)) return false;
  if (alreadySentToday(kind, current.date)) return false;

  const period = schedulePeriod(kind, now);
  const reports = REPORT_TYPES.map((item) => buildReport(item.type, { from: period.from, to: period.to }, null));
  const attachments = reports.map((report) => ({
    filename: `${kind}_${report.type}_${new Date().toISOString().slice(0, 10)}.csv`,
    content: reportToCsv(report),
    contentType: "text/csv; charset=utf-8",
  }));
  const title = `${kind.charAt(0).toUpperCase()}${kind.slice(1)} Fleet Summary`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;padding:20px">
    <div style="max-width:1000px;margin:0 auto">
      <div style="background:#0b1220;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#f5a623">Fleet Management System</div>
        <div style="font-size:22px;font-weight:700;margin-top:4px">${title}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">${period.label}</div>
      </div>
      <div style="background:#fff;padding:20px 24px;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 10px 10px">
        <p style="color:#334155;font-size:13px">Six fleet reports are attached as CSV. The sections below summarise each report.</p>
        ${reports.map((report) => reportToHtml(report)).join("<hr style=\"border:0;border-top:1px solid #e2e8f0;margin:22px 0\">")}
      </div>
    </div>
  </div>`;
  await sendReportEmail({
    reportType: kind,
    title,
    periodLabel: period.label,
    html,
    text: [`${title} — ${period.label}`, "", ...reports.map((report) => reportToText(report))].join("\n\n"),
    attachments,
    scheduled: true,
  });
  return true;
}

/** Runs due daily/weekly/monthly report dispatches. Exported for tests/ops. */
export async function runScheduledReports(now = new Date()): Promise<string[]> {
  const sent: string[] = [];
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    try {
      if (await dispatchSchedule(kind, now)) sent.push(kind);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Scheduled ${kind} report failed`, e);
    }
  }
  return sent;
}

let schedulerTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

/** Starts the 60-second scheduled-report worker. Safe to call more than once. */
export function startReportScheduler(): void {
  if (process.env.NODE_ENV === "test" || process.env.DISABLE_REPORT_SCHEDULER === "true") return;
  if (schedulerTimer) return;
  startupTimer = setTimeout(() => {
    void runScheduledReports();
  }, 5_000);
  startupTimer.unref?.();
  schedulerTimer = setInterval(() => {
    void runScheduledReports();
  }, 60_000);
  schedulerTimer.unref?.();
}
