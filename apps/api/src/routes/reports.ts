import { Router } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { resolveClientScopes } from "../utils/scope";
import { writeAudit } from "../utils/audit";
import {
  buildReport,
  isReportType,
  REPORT_TYPES,
  reportToCsv,
  reportToHtml,
  reportToText,
  type ReportFilters,
} from "../services/reporting";
import { reportRecipient, sendReportEmail } from "../services/email";

const router = Router();
router.use(requireAuth);

const EMAIL_ROLES = ["admin", "fleet_admin", "fleet_manager", "executive"];

function filtersFromQuery(query: Record<string, unknown>): ReportFilters {
  return {
    from: typeof query.from === "string" ? query.from : undefined,
    to: typeof query.to === "string" ? query.to : undefined,
    vehicleId: typeof query.vehicleId === "string" ? query.vehicleId : undefined,
    imei: typeof query.imei === "string" ? query.imei : undefined,
    group: typeof query.group === "string" ? query.group : undefined,
  };
}

/** GET /api/v1/reports/options — vehicles, fleet groups and report types for the builder. */
router.get("/options", (req, res, next) => {
  try {
    const scopes = resolveClientScopes(req.user);
    const params: unknown[] = [];
    let where = "v.status != 'disposed'";
    if (scopes && scopes.length > 0) {
      where += ` AND v.client_id IN (${scopes.map(() => "?").join(", ")})`;
      params.push(...scopes);
    }

    const vehicles = db.prepare(`
      SELECT v.id, v.vehicle_number, v.registration_number, v.department, v.client_id,
             c.name AS client_name, g.device_identifier AS imei
      FROM vehicles v
      LEFT JOIN clients c ON c.id = v.client_id
      LEFT JOIN gps_devices g ON g.vehicle_id = v.id
      WHERE ${where}
      ORDER BY v.vehicle_number ASC
    `).all(...params) as {
      id: string;
      vehicle_number: string;
      registration_number: string;
      department: string | null;
      client_id: string | null;
      client_name: string | null;
      imei: string | null;
    }[];

    const groups = [...new Set(vehicles.flatMap((v) => [v.department, v.client_name]).filter(Boolean) as string[])].sort();

    res.json({
      data: {
        report_types: REPORT_TYPES,
        vehicles,
        groups,
        recipient: reportRecipient(),
      },
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/v1/reports/:type?from&to&vehicleId&imei&group&format=csv */
router.get("/:type", (req, res, next) => {
  try {
    const type = req.params.type;
    if (!isReportType(type)) return res.status(404).json({ error: `Unknown report type: ${type}` });
    const filters = filtersFromQuery(req.query);
    const scopes = resolveClientScopes(req.user);
    const report = buildReport(type, filters, scopes);

    if (req.query.format === "csv") {
      writeAudit({
        userId: req.user!.id,
        action: "REPORT_EXPORTED",
        entity: "reports",
        entityId: type,
        newValue: { filters, rows: report.sections.reduce((sum, section) => sum + section.rows.length, 0) },
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${type}_${report.period.fromDate}_${report.period.toDate}.csv"`
      );
      return res.send(reportToCsv(report));
    }

    res.json({ data: report });
  } catch (e) {
    next(e);
  }
});

/** POST /api/v1/reports/:type/email — email the report now to fleet@dspng.tech. */
router.post("/:type/email", requireRole(...EMAIL_ROLES), async (req, res, next) => {
  try {
    const type = req.params.type;
    if (!isReportType(type)) return res.status(404).json({ error: `Unknown report type: ${type}` });
    const filters = filtersFromQuery({ ...req.query, ...(req.body ?? {}) });
    const scopes = resolveClientScopes(req.user);
    const report = buildReport(type, filters, scopes);
    const result = await sendReportEmail({
      reportType: type,
      title: report.title,
      periodLabel: `${report.period.fromPgt} to ${report.period.toPgt}`,
      html: reportToHtml(report),
      text: reportToText(report),
      csv: reportToCsv(report),
    });

    writeAudit({
      userId: req.user!.id,
      action: "REPORT_EMAILED",
      entity: "reports",
      entityId: type,
      newValue: { filters, status: result.status, recipients: result.recipients },
    });

    const message =
      result.status === "sent"
        ? `Report emailed to ${result.recipients.join(", ")}`
        : result.status === "skipped"
          ? result.error || "SMTP is not configured"
          : `Email failed: ${result.error || "unknown error"}`;
    res.status(result.status === "failed" ? 502 : 200).json({ data: result, message });
  } catch (e) {
    next(e);
  }
});

export default router;
