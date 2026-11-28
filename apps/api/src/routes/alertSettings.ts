import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { getBusinessRule, getBusinessRuleBoolean, getBusinessRuleNumber } from "./settings";
import { sendTestEmail, smtpStatus } from "../services/email";
import { writeAudit } from "../utils/audit";

const router = Router();
router.use(requireAuth);
router.use(requireRole("admin"));

function setting(key: string, fallback: string): string {
  return getBusinessRule(key, undefined, fallback);
}

function boolSetting(key: string, fallback: boolean): boolean {
  return getBusinessRuleBoolean(key, undefined, fallback);
}

function numSetting(key: string, fallback: number): number {
  return getBusinessRuleNumber(key, undefined, fallback);
}

function currentSettings() {
  return {
    smtp: smtpStatus(),
    recipients: {
      alert: setting("alert_recipient_email", "fleet@dspng.tech"),
      alertCc: setting("alert_cc_emails", ""),
      report: setting("report_recipient_email", "fleet@dspng.tech"),
      reportCc: setting("report_cc_emails", ""),
    },
    thresholds: {
      overspeedKmh: numSetting("alert_overspeed_kmh", 80),
      lowVoltageV: numSetting("alert_low_voltage_v", 11.5),
      cooldownSeconds: numSetting("alert_cooldown_seconds", 300),
      offlineMinutes: numSetting("alert_offline_minutes", 15),
      offlineCooldownMinutes: numSetting("alert_offline_cooldown_minutes", 360),
      idleMinutes: numSetting("alert_idle_minutes", 10),
    },
    toggles: {
      emailAlerts: boolSetting("alert_email_enabled", true),
      overspeed: boolSetting("alert_overspeed_enabled", true),
      ignition: boolSetting("alert_ignition_enabled", true),
      offline: boolSetting("alert_offline_enabled", true),
      power: boolSetting("alert_power_enabled", true),
      geofence: boolSetting("alert_geofence_enabled", true),
      security: boolSetting("alert_security_enabled", true),
    },
    schedule: {
      dailyEnabled: boolSetting("report_daily_enabled", true),
      dailyTime: setting("report_daily_time_pgt", "07:00"),
      weeklyEnabled: boolSetting("report_weekly_enabled", true),
      weeklyTime: setting("report_weekly_time_pgt", "07:00"),
      monthlyEnabled: boolSetting("report_monthly_enabled", true),
      monthlyTime: setting("report_monthly_time_pgt", "07:00"),
    },
  };
}

const updateSchema = z.object({
  recipients: z
    .object({
      alert: z.string().email().optional(),
      alertCc: z.string().optional(),
      report: z.string().email().optional(),
      reportCc: z.string().optional(),
    })
    .optional(),
  thresholds: z
    .object({
      overspeedKmh: z.number().min(1).max(300).optional(),
      lowVoltageV: z.number().min(0).max(60).optional(),
      cooldownSeconds: z.number().int().min(0).max(86400).optional(),
      offlineMinutes: z.number().int().min(1).max(10080).optional(),
      offlineCooldownMinutes: z.number().int().min(1).max(10080).optional(),
      idleMinutes: z.number().int().min(1).max(1440).optional(),
    })
    .optional(),
  toggles: z
    .object({
      emailAlerts: z.boolean().optional(),
      overspeed: z.boolean().optional(),
      ignition: z.boolean().optional(),
      offline: z.boolean().optional(),
      power: z.boolean().optional(),
      geofence: z.boolean().optional(),
      security: z.boolean().optional(),
    })
    .optional(),
  schedule: z
    .object({
      dailyEnabled: z.boolean().optional(),
      dailyTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      weeklyEnabled: z.boolean().optional(),
      weeklyTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      monthlyEnabled: z.boolean().optional(),
      monthlyTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    })
    .optional(),
});

function setRule(key: string, value: string, type: "string" | "number" | "boolean"): void {
  const existing = db.prepare("SELECT key FROM business_rules WHERE key = ?").get(key) as { key: string } | undefined;
  if (existing) {
    db.prepare("UPDATE business_rules SET value = ?, updated_at = datetime('now') WHERE key = ?").run(value, key);
  } else {
    db.prepare("INSERT INTO business_rules (key, value, value_type, updated_at) VALUES (?, ?, ?, datetime('now'))").run(
      key,
      value,
      type
    );
  }
}

/** GET /api/v1/alert-settings — SMTP status, rules, schedules and recipients. */
router.get("/", (_req, res, next) => {
  try {
    res.json({ data: currentSettings() });
  } catch (e) {
    next(e);
  }
});

/** PUT /api/v1/alert-settings — update alert and report email rules. */
router.put("/", (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid alert settings", details: parsed.error.flatten() });
    const input = parsed.data;

    if (input.recipients) {
      if (input.recipients.alert !== undefined) setRule("alert_recipient_email", input.recipients.alert, "string");
      if (input.recipients.alertCc !== undefined) setRule("alert_cc_emails", input.recipients.alertCc, "string");
      if (input.recipients.report !== undefined) setRule("report_recipient_email", input.recipients.report, "string");
      if (input.recipients.reportCc !== undefined) setRule("report_cc_emails", input.recipients.reportCc, "string");
    }
    if (input.thresholds) {
      const t = input.thresholds;
      if (t.overspeedKmh !== undefined) setRule("alert_overspeed_kmh", String(t.overspeedKmh), "number");
      if (t.lowVoltageV !== undefined) setRule("alert_low_voltage_v", String(t.lowVoltageV), "number");
      if (t.cooldownSeconds !== undefined) setRule("alert_cooldown_seconds", String(t.cooldownSeconds), "number");
      if (t.offlineMinutes !== undefined) setRule("alert_offline_minutes", String(t.offlineMinutes), "number");
      if (t.offlineCooldownMinutes !== undefined) setRule("alert_offline_cooldown_minutes", String(t.offlineCooldownMinutes), "number");
      if (t.idleMinutes !== undefined) setRule("alert_idle_minutes", String(t.idleMinutes), "number");
    }
    if (input.toggles) {
      const t = input.toggles;
      const map: Record<keyof typeof t, string> = {
        emailAlerts: "alert_email_enabled",
        overspeed: "alert_overspeed_enabled",
        ignition: "alert_ignition_enabled",
        offline: "alert_offline_enabled",
        power: "alert_power_enabled",
        geofence: "alert_geofence_enabled",
        security: "alert_security_enabled",
      };
      for (const [key, rule] of Object.entries(map) as [keyof typeof t, string][]) {
        const value = t[key];
        if (value !== undefined) setRule(rule, value ? "true" : "false", "boolean");
      }
    }
    if (input.schedule) {
      const s = input.schedule;
      if (s.dailyEnabled !== undefined) setRule("report_daily_enabled", s.dailyEnabled ? "true" : "false", "boolean");
      if (s.dailyTime !== undefined) setRule("report_daily_time_pgt", s.dailyTime, "string");
      if (s.weeklyEnabled !== undefined) setRule("report_weekly_enabled", s.weeklyEnabled ? "true" : "false", "boolean");
      if (s.weeklyTime !== undefined) setRule("report_weekly_time_pgt", s.weeklyTime, "string");
      if (s.monthlyEnabled !== undefined) setRule("report_monthly_enabled", s.monthlyEnabled ? "true" : "false", "boolean");
      if (s.monthlyTime !== undefined) setRule("report_monthly_time_pgt", s.monthlyTime, "string");
    }

    writeAudit({
      userId: req.user!.id,
      action: "ALERT_SETTINGS_UPDATED",
      entity: "business_rules",
      entityId: "alert_settings",
      newValue: parsed.data,
    });
    res.json({ data: currentSettings(), message: "Alert and email settings updated" });
  } catch (e) {
    next(e);
  }
});

/** POST /api/v1/alert-settings/test-email — send a test message now. */
router.post("/test-email", async (_req, res, next) => {
  try {
    const result = await sendTestEmail();
    writeAudit({
      userId: _req.user!.id,
      action: "ALERT_TEST_EMAIL_SENT",
      entity: "email_deliveries",
      newValue: { status: result.status, recipients: result.recipients, error: result.error },
    });
    const message =
      result.status === "sent"
        ? `Test email sent to ${result.recipients.join(", ")}`
        : result.status === "skipped"
          ? result.error || "SMTP is not configured"
          : `Test email failed: ${result.error || "unknown error"}`;
    res.status(result.status === "failed" ? 502 : 200).json({ data: result, message });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/alert-settings/deliveries — recent SMTP delivery attempts. */
router.get("/deliveries", (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const rows = db.prepare(`
      SELECT ed.*, fa.alert_type, fa.severity, v.vehicle_number
      FROM email_deliveries ed
      LEFT JOIN fleet_alerts fa ON fa.id = ed.related_alert_id
      LEFT JOIN vehicles v ON v.id = fa.vehicle_id
      ORDER BY ed.created_at DESC
      LIMIT ?
    `).all(limit);
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/alert-settings/alerts — recent real-time alerts. */
router.get("/alerts", (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const rows = db.prepare(`
      SELECT fa.*, v.vehicle_number, v.registration_number
      FROM fleet_alerts fa
      LEFT JOIN vehicles v ON v.id = fa.vehicle_id
      ORDER BY fa.created_at DESC
      LIMIT ?
    `).all(limit);
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

/** PATCH /api/v1/alert-settings/alerts/:id/ack — acknowledge an alert. */
router.patch("/alerts/:id/ack", (req, res, next) => {
  try {
    const existing = db.prepare("SELECT id FROM fleet_alerts WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Alert not found" });
    db.prepare("UPDATE fleet_alerts SET acknowledged = 1, acknowledged_at = datetime('now') WHERE id = ?").run(req.params.id);
    writeAudit({
      userId: req.user!.id,
      action: "FLEET_ALERT_ACKNOWLEDGED",
      entity: "fleet_alerts",
      entityId: req.params.id,
    });
    res.json({ data: db.prepare("SELECT * FROM fleet_alerts WHERE id = ?").get(req.params.id) });
  } catch (e) {
    next(e);
  }
});

export default router;
