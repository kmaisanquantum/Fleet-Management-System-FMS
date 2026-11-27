import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { writeAudit } from "../utils/audit";

const router = Router();
router.use(requireAuth);

const FLEET_WRITE_ROLES = ["admin", "fleet_admin", "fleet_manager", "department_manager"];

router.get("/", (req, res) => {
  const { vehicleId } = req.query;
  let query = `
    SELECT va.*, v.vehicle_number, v.make, v.model, d.name as driver_name
    FROM vehicle_allocations va
    JOIN vehicles v ON v.id = va.vehicle_id
    LEFT JOIN drivers d ON d.id = va.driver_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (vehicleId) {
    query += " AND va.vehicle_id = ?";
    params.push(vehicleId);
  }
  query += " ORDER BY va.allocation_date DESC";
  const rows = db.prepare(query).all(...params);
  res.json({ data: rows });
});

const allocationSchema = z.object({
  vehicleId: z.string().min(1),
  department: z.string().optional(),
  custodian: z.string().optional(),
  driverId: z.string().optional(),
  allocationDate: z.string().min(1),
  returnDate: z.string().optional(),
  approvalStatus: z.enum(["pending", "approved", "rejected", "returned"]).default("approved"),
  authorisationStatus: z.enum(["active", "expired", "revoked"]).default("active"),
  notes: z.string().optional(),
});

router.post("/", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const input = allocationSchema.parse(req.body);
    const id = uuid();
    const createAllocation = db.transaction(() => {
      // A vehicle and a driver can each have only one active allocation.
      if (input.authorisationStatus === "active") {
        db.prepare(`
          UPDATE vehicle_allocations
          SET authorisation_status = 'expired',
              return_date = COALESCE(return_date, date('now'))
          WHERE vehicle_id = ? AND authorisation_status = 'active'
        `).run(input.vehicleId);
        if (input.driverId) {
          db.prepare(`
            UPDATE vehicle_allocations
            SET authorisation_status = 'expired',
                return_date = COALESCE(return_date, date('now'))
            WHERE driver_id = ? AND authorisation_status = 'active'
          `).run(input.driverId);
        }
      }

      db.prepare(`
        INSERT INTO vehicle_allocations (
          id, vehicle_id, department, custodian, driver_id, allocation_date, return_date,
          approval_status, authorisation_status, notes
        ) VALUES (
          @id, @vehicleId, @department, @custodian, @driverId, @allocationDate, @returnDate,
          @approvalStatus, @authorisationStatus, @notes
        )
      `).run({
        id,
        vehicleId: input.vehicleId,
        department: input.department ?? null,
        custodian: input.custodian ?? null,
        driverId: input.driverId ?? null,
        allocationDate: input.allocationDate,
        returnDate: input.returnDate ?? null,
        approvalStatus: input.approvalStatus,
        authorisationStatus: input.authorisationStatus,
        notes: input.notes ?? null,
      });
    });
    createAllocation();

    writeAudit({ userId: req.user!.id, action: "VEHICLE_ALLOCATED", entity: "vehicle_allocations", entityId: id, newValue: input });
    const created = db.prepare("SELECT * FROM vehicle_allocations WHERE id = ?").get(id);
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.patch("/:id/status", requireRole(...FLEET_WRITE_ROLES), (req, res, next) => {
  try {
    const { approvalStatus, authorisationStatus, returnDate } = z.object({
      approvalStatus: z.enum(["pending", "approved", "rejected", "returned"]).optional(),
      authorisationStatus: z.enum(["active", "expired", "revoked"]).optional(),
      returnDate: z.string().optional(),
    }).parse(req.body);

    db.prepare(`
      UPDATE vehicle_allocations SET
        approval_status = COALESCE(?, approval_status),
        authorisation_status = COALESCE(?, authorisation_status),
        return_date = COALESCE(?, return_date)
      WHERE id = ?
    `).run(approvalStatus ?? null, authorisationStatus ?? null, returnDate ?? null, req.params.id);

    writeAudit({ userId: req.user!.id, action: "ALLOCATION_STATUS_CHANGED", entity: "vehicle_allocations", entityId: req.params.id, newValue: req.body });
    res.json({ data: db.prepare("SELECT * FROM vehicle_allocations WHERE id = ?").get(req.params.id) });
  } catch (e) { next(e); }
});

export default router;
