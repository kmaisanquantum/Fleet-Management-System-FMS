import nodemailer, { type Transporter } from "nodemailer";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { getBusinessRule, getBusinessRuleBoolean } from "../routes/settings";

export type MailKind = "alert" | "report" | "test" | "scheduled_report";
export type MailStatus = "sent" | "failed" | "skipped";

export interface MailAttachment {
  filename: string;
  content: string;
  contentType?: string;
}

export interface SendMailInput {
  kind: MailKind;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
  relatedAlertId?: string;
  reportType?: string;
}

export interface SendMailResult {
  status: MailStatus;
  messageId?: string;
  error?: string;
  recipients: string[];
  cc: string[];
}

export interface SmtpStatus {
  configured: boolean;
  host: string | null;
  port: number;
  secure: boolean;
  from: string;
  authConfigured: boolean;
}

const DEFAULT_FROM = "fleet@dspng.tech";
let cachedTransport: Transporter | null = null;
let cachedTransportKey = "";

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function smtpPort(): number {
  const port = Number(process.env.SMTP_PORT);
  return Number.isFinite(port) && port > 0 ? port : 587;
}

export function smtpStatus(): SmtpStatus {
  const host = process.env.SMTP_HOST?.trim() || null;
  return {
    configured: Boolean(host),
    host,
    port: smtpPort(),
    secure: boolEnv(process.env.SMTP_SECURE, smtpPort() === 465),
    from: process.env.SMTP_FROM?.trim() || DEFAULT_FROM,
    authConfigured: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS),
  };
}

function getTransport(): Transporter | null {
  const status = smtpStatus();
  if (!status.configured) return null;

  const key = [status.host, status.port, status.secure, process.env.SMTP_USER ?? "", process.env.SMTP_PASS ?? ""].join("|");
  if (cachedTransport && cachedTransportKey === key) return cachedTransport;

  cachedTransport = nodemailer.createTransport({
    host: status.host!,
    port: status.port,
    secure: status.secure,
    auth: status.authConfigured
      ? { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cachedTransportKey = key;
  return cachedTransport;
}

/** Splits a comma/semicolon-separated recipient setting into clean addresses. */
export function parseRecipients(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueRecipients(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function alertRecipient(): string {
  return (
    getBusinessRule("alert_recipient_email", "ALERT_RECIPIENT_EMAIL", DEFAULT_FROM) ||
    DEFAULT_FROM
  );
}

export function alertCcRecipients(): string[] {
  return parseRecipients(getBusinessRule("alert_cc_emails", undefined, ""));
}

export function reportRecipient(): string {
  return (
    getBusinessRule("report_recipient_email", "REPORT_RECIPIENT_EMAIL", DEFAULT_FROM) ||
    DEFAULT_FROM
  );
}

export function reportCcRecipients(): string[] {
  return parseRecipients(getBusinessRule("report_cc_emails", undefined, ""));
}

function logDelivery(input: {
  kind: MailKind;
  recipient: string;
  cc?: string[];
  subject: string;
  status: MailStatus;
  messageId?: string;
  error?: string;
  relatedAlertId?: string;
  reportType?: string;
}): void {
  try {
    db.prepare(`
      INSERT INTO email_deliveries (
        id, kind, recipient, cc, subject, status, message_id, error, related_alert_id, report_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuid(),
      input.kind,
      input.recipient,
      input.cc?.length ? input.cc.join(", ") : null,
      input.subject,
      input.status,
      input.messageId ?? null,
      input.error ?? null,
      input.relatedAlertId ?? null,
      input.reportType ?? null
    );
  } catch {
    // Delivery logging must never prevent the email path from completing.
  }
}

/** Sends an email through the configured SMTP transport and records the attempt. */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const to = uniqueRecipients(parseRecipients(input.to));
  const cc = uniqueRecipients(parseRecipients(input.cc));
  if (to.length === 0) {
    const error = "No recipient configured";
    logDelivery({ ...input, recipient: "", cc, status: "failed", error });
    return { status: "failed", error, recipients: [], cc };
  }

  const transport = getTransport();
  if (!transport) {
    const error = "SMTP is not configured (SMTP_HOST is missing)";
    logDelivery({ ...input, recipient: to.join(", "), cc, status: "skipped", error });
    return { status: "skipped", error, recipients: to, cc };
  }

  try {
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM?.trim() || DEFAULT_FROM,
      to: to.join(", "),
      cc: cc.length ? cc.join(", ") : undefined,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType ?? "text/csv",
      })),
    });
    const messageId = typeof info.messageId === "string" ? info.messageId : undefined;
    logDelivery({ ...input, recipient: to.join(", "), cc, status: "sent", messageId });
    return { status: "sent", messageId, recipients: to, cc };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logDelivery({ ...input, recipient: to.join(", "), cc, status: "failed", error });
    return { status: "failed", error, recipients: to, cc };
  }
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

const PGT_OFFSET_MS = 10 * 60 * 60 * 1000;

function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) return new Date(`${raw.replace(" ", "T")}Z`);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Formats a UTC database timestamp as Port Moresby time (UTC+10). */
export function formatPgt(value: string | null | undefined): string {
  const date = parseUtc(value);
  if (!date) return "—";
  const pgt = new Date(date.getTime() + PGT_OFFSET_MS);
  return `${pgt.toISOString().replace("T", " ").slice(0, 19)} PGT`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mapsLink(lat: number | null | undefined, lon: number | null | undefined): string | null {
  if (lat == null || lon == null) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

const ALERT_LABELS: Record<string, string> = {
  overspeed: "Overspeeding",
  ignition_on: "Ignition ON",
  ignition_off: "Ignition OFF",
  device_offline: "Device Offline",
  power_cut: "Power Cut",
  low_voltage: "Low External Voltage",
  geofence_entry: "Geofence Entry",
  geofence_exit: "Geofence Exit",
  jamming: "Jamming Detected",
  immobilizer: "Immobilizer / DOUT",
  sos: "SOS Trigger",
  din_trigger: "Digital Input Trigger",
  crash: "Crash Detected",
  towing: "Towing Detected",
  excessive_idling: "Excessive Idling",
  harsh_acceleration: "Harsh Acceleration",
  harsh_braking: "Harsh Braking",
};

export function alertTypeLabel(alertType: string): string {
  return ALERT_LABELS[alertType] ?? alertType.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/* ------------------------------------------------------------------ *
 * Alert email
 * ------------------------------------------------------------------ */

interface AlertEmailRow {
  id: string;
  imei: string;
  vehicle_id: string | null;
  alert_type: string;
  severity: string;
  message: string;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  voltage: number | null;
  created_at: string;
  vehicle_number: string | null;
  registration_number: string | null;
  make: string | null;
  model: string | null;
}

export function alertEmailContent(alert: AlertEmailRow): { subject: string; text: string; html: string } {
  const label = alertTypeLabel(alert.alert_type);
  const vehicle = alert.vehicle_number
    ? `${alert.vehicle_number}${alert.registration_number ? ` (${alert.registration_number})` : ""}`
    : "Unassigned vehicle";
  const mapUrl = mapsLink(alert.lat, alert.lon);
  const subject = `[FMS ${alert.severity.toUpperCase()}] ${label} — ${vehicle}`;

  const rows: [string, string][] = [
    ["Vehicle", vehicle],
    ["Make / model", [alert.make, alert.model].filter(Boolean).join(" ") || "—"],
    ["IMEI", alert.imei],
    ["Alert type", label],
    ["Severity", alert.severity.toUpperCase()],
    ["Timestamp", formatPgt(alert.created_at)],
    ["Speed", alert.speed != null ? `${alert.speed.toFixed(1)} km/h` : "—"],
    ["Voltage", alert.voltage != null ? `${alert.voltage.toFixed(2)} V` : "—"],
    ["Coordinates", alert.lat != null && alert.lon != null ? `${alert.lat.toFixed(6)}, ${alert.lon.toFixed(6)}` : "—"],
    ["Details", alert.message],
  ];

  const text = [
    `Fleet Management System — ${label}`,
    "",
    ...rows.map(([key, value]) => `${key}: ${value}`),
    ...(mapUrl ? ["", `Map: ${mapUrl}`] : []),
    "",
    "This alert was generated automatically by the FMS telemetry pipeline.",
  ].join("\n");

  const htmlRows = rows
    .map(
      ([key, value]) =>
        `<tr><td style="padding:8px 12px;color:#64748b;font-size:12px;white-space:nowrap;vertical-align:top">${escapeHtml(
          key
        )}</td><td style="padding:8px 12px;color:#0f172a;font-size:13px">${escapeHtml(value)}</td></tr>`
    )
    .join("");

  const severityColor = alert.severity === "critical" ? "#dc2626" : alert.severity === "warning" ? "#d97706" : "#2563eb";
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
    <div style="background:#0b1220;padding:18px 22px;color:#ffffff">
      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#f5a623">Fleet Management System</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px">${escapeHtml(label)}</div>
    </div>
    <div style="padding:18px 22px">
      <div style="display:inline-block;padding:4px 9px;border-radius:999px;background:${severityColor};color:#fff;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(
        alert.severity
      )}</div>
      <p style="color:#334155;font-size:14px;margin:14px 0 16px">${escapeHtml(alert.message)}</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px">${htmlRows}</table>
      ${
        mapUrl
          ? `<p style="margin:18px 0 0"><a href="${mapUrl}" style="display:inline-block;background:#f5a623;color:#0b1220;text-decoration:none;font-weight:700;font-size:13px;padding:10px 16px;border-radius:6px">Open location in Google Maps</a></p>`
          : ""
      }
      <p style="color:#94a3b8;font-size:11px;margin:18px 0 0">Generated automatically by the FMS telemetry pipeline. Do not reply to this message.</p>
    </div>
  </div>
</body></html>`;

  return { subject, text, html };
}

/** Sends the email for a persisted fleet alert and updates its delivery flags. */
export async function sendAlertEmail(alertId: string): Promise<SendMailResult> {
  const alert = db.prepare(`
    SELECT fa.*, v.vehicle_number, v.registration_number, v.make, v.model
    FROM fleet_alerts fa
    LEFT JOIN vehicles v ON v.id = fa.vehicle_id
    WHERE fa.id = ?
  `).get(alertId) as AlertEmailRow | undefined;

  if (!alert) {
    return { status: "failed", error: "Alert not found", recipients: [], cc: [] };
  }

  if (!getBusinessRuleBoolean("alert_email_enabled", undefined, true)) {
    const error = "Email alerts are disabled in settings";
    logDelivery({
      kind: "alert",
      recipient: alertRecipient(),
      cc: alertCcRecipients(),
      subject: `[FMS] ${alertTypeLabel(alert.alert_type)}`,
      status: "skipped",
      error,
      relatedAlertId: alert.id,
    });
    return { status: "skipped", error, recipients: [], cc: [] };
  }

  const content = alertEmailContent(alert);
  const result = await sendMail({
    kind: "alert",
    to: alertRecipient(),
    cc: alertCcRecipients().join(", "),
    subject: content.subject,
    text: content.text,
    html: content.html,
    relatedAlertId: alert.id,
  });

  if (result.status === "sent") {
    db.prepare("UPDATE fleet_alerts SET email_sent = 1, email_sent_at = datetime('now'), email_error = NULL WHERE id = ?").run(
      alert.id
    );
  } else {
    db.prepare("UPDATE fleet_alerts SET email_sent = 0, email_error = ? WHERE id = ?").run(result.error ?? "Unknown email error", alert.id);
  }
  return result;
}

/**
 * Sends a generated fleet report to the configured report recipients. The CSV
 * body is attached so the message is useful even without opening the HTML.
 */
export async function sendReportEmail(input: {
  reportType: string;
  title: string;
  periodLabel: string;
  html: string;
  text: string;
  csv?: string;
  attachments?: MailAttachment[];
  scheduled?: boolean;
}): Promise<SendMailResult> {
  const attachments =
    input.attachments ??
    (input.csv
      ? [{ filename: `${input.reportType}_${new Date().toISOString().slice(0, 10)}.csv`, content: input.csv, contentType: "text/csv; charset=utf-8" }]
      : []);
  return sendMail({
    kind: input.scheduled ? "scheduled_report" : "report",
    to: reportRecipient(),
    cc: reportCcRecipients().join(", "),
    subject: `${input.scheduled ? "[FMS Scheduled] " : "[FMS Report] "}${input.title} — ${input.periodLabel}`,
    text: input.text,
    html: input.html,
    attachments,
    reportType: input.reportType,
  });
}

/** Sends an operator-triggered SMTP test message. */
export async function sendTestEmail(): Promise<SendMailResult & { smtp: SmtpStatus }> {
  const smtp = smtpStatus();
  const result = await sendMail({
    kind: "test",
    to: alertRecipient(),
    cc: alertCcRecipients().join(", "),
    subject: `FMS SMTP test — ${alertRecipient()}`,
    text: [
      "Fleet Management System SMTP test",
      "",
      `Time: ${formatPgt(new Date().toISOString())}`,
      "If you received this message, alert and scheduled report delivery is working.",
    ].join("\n"),
    html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a">
      <h2 style="margin:0 0 8px">FMS SMTP test</h2>
      <p style="color:#475569">If you received this message, alert and scheduled report delivery is working.</p>
      <p style="color:#94a3b8;font-size:12px">Sent ${escapeHtml(formatPgt(new Date().toISOString()))}</p>
    </div>`,
  });
  return { ...result, smtp };
}
