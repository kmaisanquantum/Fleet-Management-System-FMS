import { Router, Request } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { ApiError } from "../middleware/errorHandler";
import { writeAudit } from "../utils/audit";
import { createNotification, maybeClearVehicleFlag } from "../services/driverPortal";

/**
 * Admin-side review of Driver Portal submissions. Lets driver submissions
 * surface in the corresponding administration modules (inspections, fuel
 * verification, faults, incidents, maintenance, leave, documents, messaging).
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole("admin", "fleet_admin", "fleet_manager"));

function audit(req: Request, action: string, entity: string, entityId: string, newValue?: unknown, previousValue?: unknown) {
  writeAudit({
    userId: req.user?.id ?? null,
    role: req.user?.roleName ?? null,
    action,
    entity,
    entityId,
    newValue,
    previousValue,
    ipAddress: req.ip,
    device: (req.headers["user-agent"] as string) ?? null,
  });
}

/* ---------------------------- Faults ---------------------------- */

router.get("/faults", (req, res, next) => {
  try {
    const { status, severity } = req.query;
    let sql = `
      SELECT vf.*, v.vehicle_number, d.name AS driver_name, d.employee_number
      FROM vehicle_faults vf
      JOIN vehicles v ON v.id = vf.vehicle_id
      LEFT JOIN drivers d ON d.id = vf.driver_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (status) { sql += " AND vf.status = ?"; params.push(status); }
    if (severity) { sql += " AND vf.severity = ?"; params.push(severity); }
    sql += " ORDER BY CASE vf.severity WHEN 'critical' THEN 1 WHEN 'major' THEN 2 ELSE 3 END, vf.created_at DESC";
    res.json({ data: db.prepare(sql).all(...params) });
  } catch (e) { next(e); }
});

router.patch("/faults/:id", (req, res, next) => {
  try {
    const input = z.object({
      status: z.enum(["open", "acknowledged", "in_progress", "resolved", "cleared", "rejected"]),
      adminNotes: z.string().optional(),
    }).parse(req.body);

    const before = db.prepare("SELECT * FROM vehicle_faults WHERE id = ?").get(req.params.id) as any;
    if (!before) throw new ApiError(404, "Fault not found");

    db.prepare("UPDATE vehicle_faults SET status = ?, admin_notes = COALESCE(?, admin_notes), updated_at = datetime('now') WHERE id = ?")
      .run(input.status, input.adminNotes ?? null, req.params.id);

    if (input.status === "cleared" || input.status === "resolved") {
      maybeClearVehicleFlag(before.vehicle_id);
      const driverUser = before.driver_id
        ? db.prepare("SELECT id FROM users WHERE driver_id = ? LIMIT 1").get(before.driver_id) as { id: string } | undefined
        : undefined;
      if (driverUser) {
        createNotification({
          userId: driverUser.id, driverId: before.driver_id, title: "Fault cleared",
          body: `Your reported fault has been marked as ${input.status} by an administrator.`,
          category: "fault", relatedEntity: "vehicle_faults", relatedId: req.params.id, createdBy: req.user!.id,
        });
      }
    }

    audit(req, "FAULT_REVIEWED", "vehicle_faults", req.params.id, input, before);
    res.json({ data: db.prepare("SELECT * FROM vehicle_faults WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

/* --------------------------- Incidents -------------------------- */

router.get("/incidents", (req, res, next) => {
  try {
    const { status, type } = req.query;
    let sql = `
      SELECT ir.*, v.vehicle_number, d.name AS driver_name
      FROM incident_reports ir
      LEFT JOIN vehicles v ON v.id = ir.vehicle_id
      LEFT JOIN drivers d ON d.id = ir.driver_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (status) { sql += " AND ir.status = ?"; params.push(status); }
    if (type) { sql += " AND ir.incident_type = ?"; params.push(type); }
    sql += " ORDER BY ir.created_at DESC";
    res.json({ data: db.prepare(sql).all(...params) });
  } catch (e) { next(e); }
});

router.patch("/incidents/:id", (req, res, next) => {
  try {
    const input = z.object({
      status: z.enum(["submitted", "under_review", "investigating", "closed"]),
      adminNotes: z.string().optional(),
    }).parse(req.body);

    const before = db.prepare("SELECT * FROM incident_reports WHERE id = ?").get(req.params.id) as any;
    if (!before) throw new ApiError(404, "Incident not found");

    db.prepare("UPDATE incident_reports SET status = ?, admin_notes = COALESCE(?, admin_notes), updated_at = datetime('now') WHERE id = ?")
      .run(input.status, input.adminNotes ?? null, req.params.id);

    audit(req, "INCIDENT_REVIEWED", "incident_reports", req.params.id, input, before);
    res.json({ data: db.prepare("SELECT * FROM incident_reports WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

/* ----------------------------- Leave ---------------------------- */

router.get("/leave", (req, res, next) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT dl.*, d.name AS driver_name, d.employee_number
      FROM driver_leave_requests dl
      LEFT JOIN drivers d ON d.id = dl.driver_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (status) { sql += " AND dl.status = ?"; params.push(status); }
    sql += " ORDER BY dl.created_at DESC";
    res.json({ data: db.prepare(sql).all(...params) });
  } catch (e) { next(e); }
});

router.patch("/leave/:id", (req, res, next) => {
  try {
    const input = z.object({
      status: z.enum(["pending", "approved", "rejected", "cancelled"]),
      adminNotes: z.string().optional(),
    }).parse(req.body);

    const before = db.prepare("SELECT * FROM driver_leave_requests WHERE id = ?").get(req.params.id) as any;
    if (!before) throw new ApiError(404, "Leave request not found");

    db.prepare(`
      UPDATE driver_leave_requests
      SET status = ?, admin_notes = COALESCE(?, admin_notes), reviewed_by = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).run(input.status, input.adminNotes ?? null, req.user!.id, req.params.id);

    if (before.user_id) {
      createNotification({
        userId: before.user_id, driverId: before.driver_id, title: `Leave request ${input.status}`,
        body: `Your leave request (${before.start_date} → ${before.end_date}) has been ${input.status}.`,
        category: "leave", relatedEntity: "driver_leave_requests", relatedId: req.params.id, createdBy: req.user!.id,
      });
    }

    audit(req, "LEAVE_REVIEWED", "driver_leave_requests", req.params.id, input, before);
    res.json({ data: db.prepare("SELECT * FROM driver_leave_requests WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

/* --------------------------- Documents -------------------------- */

router.get("/documents", (req, res, next) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT dd.*, d.name AS driver_name, d.employee_number
      FROM driver_documents dd
      LEFT JOIN drivers d ON d.id = dd.driver_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (status) { sql += " AND dd.status = ?"; params.push(status); }
    sql += " ORDER BY dd.created_at DESC";
    res.json({ data: db.prepare(sql).all(...params) });
  } catch (e) { next(e); }
});

router.patch("/documents/:id", (req, res, next) => {
  try {
    const input = z.object({
      status: z.enum(["pending", "verified", "rejected", "expired"]),
      adminNotes: z.string().optional(),
    }).parse(req.body);

    const before = db.prepare("SELECT * FROM driver_documents WHERE id = ?").get(req.params.id) as any;
    if (!before) throw new ApiError(404, "Document not found");

    db.prepare(`
      UPDATE driver_documents
      SET status = ?, admin_notes = COALESCE(?, admin_notes), reviewed_by = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).run(input.status, input.adminNotes ?? null, req.user!.id, req.params.id);

    if (before.user_id) {
      createNotification({
        userId: before.user_id, driverId: before.driver_id, title: `Document ${input.status}`,
        body: `Your document "${before.title}" has been ${input.status}.`,
        category: "document", relatedEntity: "driver_documents", relatedId: req.params.id, createdBy: req.user!.id,
      });
    }

    audit(req, "DOCUMENT_REVIEWED", "driver_documents", req.params.id, input, before);
    res.json({ data: db.prepare("SELECT * FROM driver_documents WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

/* ---------------------- Fuel verification ----------------------- */

router.get("/fuel-logs", (req, res, next) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT fl.*, v.vehicle_number, d.name AS driver_name
      FROM vehicle_fuel_logs fl
      JOIN vehicles v ON v.id = fl.vehicle_id
      LEFT JOIN drivers d ON d.id = fl.driver_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (status) { sql += " AND fl.reconciliation_status = ?"; params.push(status); }
    sql += " ORDER BY fl.created_at DESC";
    res.json({ data: db.prepare(sql).all(...params) });
  } catch (e) { next(e); }
});

router.patch("/fuel-logs/:id/verify", (req, res, next) => {
  try {
    const input = z.object({
      reconciliationStatus: z.enum(["verified", "exception", "pending"]),
      notes: z.string().optional(),
    }).parse(req.body);

    const before = db.prepare("SELECT * FROM vehicle_fuel_logs WHERE id = ?").get(req.params.id) as any;
    if (!before) throw new ApiError(404, "Fuel log not found");

    db.prepare("UPDATE vehicle_fuel_logs SET reconciliation_status = ?, gps_verified = CASE WHEN ? = 'verified' THEN 1 ELSE gps_verified END WHERE id = ?")
      .run(input.reconciliationStatus, input.reconciliationStatus, req.params.id);

    audit(req, "FUEL_LOG_VERIFIED", "vehicle_fuel_logs", req.params.id, input, before);
    res.json({ data: db.prepare("SELECT * FROM vehicle_fuel_logs WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

/* ------------------------ Inspections --------------------------- */

router.get("/inspections", (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT vi.*, v.vehicle_number, d.name AS driver_name
      FROM vehicle_inspections vi
      JOIN vehicles v ON v.id = vi.vehicle_id
      LEFT JOIN drivers d ON d.id = vi.driver_id
      ORDER BY vi.inspection_date DESC, vi.created_at DESC
    `).all() as any[];
    const itemsByInspection: Record<string, any[]> = {};
    for (const row of rows) {
      itemsByInspection[row.id] = db.prepare("SELECT * FROM inspection_items WHERE inspection_id = ?").all(row.id) as any[];
    }
    res.json({ data: rows.map((r) => ({ ...r, items: itemsByInspection[r.id] ?? [] })) });
  } catch (e) { next(e); }
});

router.patch("/inspections/:id/clear", (req, res, next) => {
  try {
    const input = z.object({ notes: z.string().optional() }).parse(req.body ?? {});
    const before = db.prepare("SELECT * FROM vehicle_inspections WHERE id = ?").get(req.params.id) as any;
    if (!before) throw new ApiError(404, "Inspection not found");

    db.prepare("UPDATE vehicle_inspections SET cleared = 1, notes = COALESCE(?, notes) WHERE id = ?").run(input.notes ?? null, req.params.id);
    maybeClearVehicleFlag(before.vehicle_id);

    audit(req, "INSPECTION_CRITICAL_CLEARED", "vehicle_inspections", req.params.id, input, before);
    res.json({ data: db.prepare("SELECT * FROM vehicle_inspections WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

/* ------------------------ Notifications ------------------------- */

router.post("/notifications", (req, res, next) => {
  try {
    const input = z.object({
      driverId: z.string().optional(),
      userId: z.string().optional(),
      title: z.string().min(1),
      body: z.string().min(1),
      category: z.string().optional(),
    }).refine((v) => v.driverId || v.userId, { message: "driverId or userId is required" }).parse(req.body);

    let userId = input.userId ?? null;
    if (!userId && input.driverId) {
      const row = db.prepare("SELECT id FROM users WHERE driver_id = ? LIMIT 1").get(input.driverId) as { id: string } | undefined;
      if (!row) throw new ApiError(404, "No login account is linked to that driver");
      userId = row.id;
    }

    const id = createNotification({
      userId: userId!,
      driverId: input.driverId ?? null,
      title: input.title,
      body: input.body,
      category: input.category ?? "general",
      createdBy: req.user!.id,
    });

    audit(req, "DRIVER_NOTIFICATION_SENT", "driver_notifications", id, { driverId: input.driverId, userId });
    res.status(201).json({ data: db.prepare("SELECT * FROM driver_notifications WHERE id = ?").get(id) });
  } catch (e) { next(e); }
});

/* ---------------------- Maintenance requests -------------------- */

router.get("/maintenance-requests", (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT vm.*, v.vehicle_number, d.name AS driver_name
      FROM vehicle_maintenance vm
      JOIN vehicles v ON v.id = vm.vehicle_id
      LEFT JOIN drivers d ON d.id = vm.driver_id
      WHERE vm.requested_by IS NOT NULL
      ORDER BY vm.created_at DESC
    `).all();
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.patch("/maintenance-requests/:id", (req, res, next) => {
  try {
    const input = z.object({
      status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]),
      scheduledDate: z.string().optional(),
      technician: z.string().optional(),
      adminNotes: z.string().optional(),
    }).parse(req.body);

    const before = db.prepare("SELECT * FROM vehicle_maintenance WHERE id = ?").get(req.params.id) as any;
    if (!before) throw new ApiError(404, "Maintenance request not found");

    db.prepare(`
      UPDATE vehicle_maintenance
      SET status = ?, scheduled_date = COALESCE(?, scheduled_date), technician = COALESCE(?, technician),
          parts = COALESCE(?, parts)
      WHERE id = ?
    `).run(input.status, input.scheduledDate ?? null, input.technician ?? null, input.adminNotes ?? null, req.params.id);

    audit(req, "MAINTENANCE_REQUEST_REVIEWED", "vehicle_maintenance", req.params.id, input, before);
    res.json({ data: db.prepare("SELECT * FROM vehicle_maintenance WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

export default router;
