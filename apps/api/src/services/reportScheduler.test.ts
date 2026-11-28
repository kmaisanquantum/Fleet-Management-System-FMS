import { describe, it, expect, beforeAll } from "vitest";
import { db, initSchema } from "../db";
import { runScheduledReports } from "./reportScheduler";

/** Scheduled dispatcher: due daily report, one delivery, no duplicate retry. */

function setRule(key: string, value: string): void {
  const existing = db.prepare("SELECT key FROM business_rules WHERE key = ?").get(key) as { key: string } | undefined;
  if (existing) {
    db.prepare("UPDATE business_rules SET value = ? WHERE key = ?").run(value, key);
  } else {
    db.prepare("INSERT INTO business_rules (key, value, value_type) VALUES (?, ?, 'string')").run(key, value);
  }
}

describe("Scheduled report dispatcher", () => {
  beforeAll(() => {
    initSchema();
    db.prepare("DELETE FROM email_deliveries WHERE kind = 'scheduled_report'").run();
    setRule("report_daily_enabled", "true");
    setRule("report_daily_time_pgt", "00:00");
    setRule("report_weekly_enabled", "false");
    setRule("report_monthly_enabled", "false");
  });

  it("dispatches a due daily report once and suppresses a repeat", async () => {
    const now = new Date();
    const first = await runScheduledReports(now);
    expect(first).toContain("daily");

    const delivery = db
      .prepare("SELECT kind, report_type, status FROM email_deliveries WHERE kind = 'scheduled_report' ORDER BY created_at DESC LIMIT 1")
      .get() as { kind: string; report_type: string; status: string };
    expect(delivery.kind).toBe("scheduled_report");
    expect(delivery.report_type).toBe("daily");
    expect(["sent", "skipped", "failed"]).toContain(delivery.status);

    const second = await runScheduledReports(now);
    expect(second).not.toContain("daily");
  });
});
