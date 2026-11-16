import { Router } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { writeAudit } from "../utils/audit";

const router = Router();
router.use(requireAuth);
router.use(requireRole("admin"));

router.get("/", (_req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.email, u.full_name, u.status, u.airport_id, u.role_id, u.driver_id, r.name as role_name, u.created_at
    FROM users u JOIN roles r ON u.role_id = r.id
    WHERE u.status != 'deleted'
    ORDER BY u.full_name
  `).all();
  res.json({ data: rows });
});

router.get("/roles", (_req, res) => {
  res.json({ data: db.prepare(`SELECT * FROM roles ORDER BY name`).all() });
});

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2),
  roleId: z.string(),
  airportId: z.string().optional(),
  driverId: z.string().optional(),
});

router.post("/", (req, res, next) => {
  try {
    const input = schema.parse(req.body);
    const id = uuid();
    const passwordHash = bcrypt.hashSync(input.password, 10);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, full_name, role_id, airport_id, driver_id, status, created_by, updated_by)
      VALUES (@id, @email, @passwordHash, @fullName, @roleId, @airportId, @driverId, 'active', @createdBy, @createdBy)
    `).run({
      id,
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      roleId: input.roleId,
      airportId: input.airportId ?? null,
      driverId: input.driverId ?? null,
      createdBy: req.user!.id,
    });
    writeAudit({
      userId: req.user!.id,
      action: "USER_CREATED",
      entity: "users",
      entityId: id,
      newValue: { email: input.email, roleId: input.roleId, driverId: input.driverId ?? null },
    });
    res.status(201).json({ data: { id, email: input.email, fullName: input.fullName } });
  } catch (e) {
    next(e);
  }
});

const editSchema = z.object({
  fullName: z.string().min(2).optional(),
  full_name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  roleId: z.string().optional(),
  role_id: z.string().optional(),
  airportId: z.string().nullable().optional(),
  airport_id: z.string().nullable().optional(),
  driverId: z.string().nullable().optional(),
  driver_id: z.string().nullable().optional(),
});

router.patch("/:id", (req, res, next) => {
  try {
    const input = editSchema.parse(req.body);
    const fullName = input.fullName ?? input.full_name;
    const email = input.email;
    const roleId = input.roleId ?? input.role_id;
    const airportId = input.airportId !== undefined ? input.airportId : input.airport_id;
    const driverId = input.driverId !== undefined ? input.driverId : input.driver_id;

    const before = db
      .prepare(`SELECT id, email, full_name, role_id, airport_id, driver_id, status FROM users WHERE id = ? AND status != 'deleted'`)
      .get(req.params.id) as any;

    if (!before) {
      return res.status(404).json({ error: "User not found" });
    }

    const fields: string[] = [];
    const params: Record<string, any> = {};

    if (fullName !== undefined) {
      fields.push("full_name = @fullName");
      params.fullName = fullName;
    }
    if (email !== undefined) {
      fields.push("email = @email");
      params.email = email;
    }
    if (roleId !== undefined) {
      fields.push("role_id = @roleId");
      params.roleId = roleId;
    }
    if (airportId !== undefined) {
      fields.push("airport_id = @airportId");
      params.airportId = airportId;
    }
    if (driverId !== undefined) {
      fields.push("driver_id = @driverId");
      params.driverId = driverId;
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      fields.push("updated_by = @updatedBy");
      params.updatedBy = req.user!.id;
      params.id = req.params.id;

      db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = @id`).run(params);

      writeAudit({
        userId: req.user!.id,
        action: "USER_UPDATED",
        entity: "users",
        entityId: req.params.id,
        previousValue: before,
        newValue: { fullName, email, roleId, airportId, driverId },
      });
    }

    const updated = db
      .prepare(
        `
        SELECT u.id, u.email, u.full_name, u.status, u.airport_id, u.role_id, u.driver_id, r.name as role_name, u.created_at
        FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?
      `
      )
      .get(req.params.id);

    res.json({ data: updated });
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/role", (req, res, next) => {
  try {
    const { roleId } = z.object({ roleId: z.string() }).parse(req.body);
    const before = db.prepare(`SELECT role_id FROM users WHERE id = ?`).get(req.params.id);
    db.prepare(`UPDATE users SET role_id = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`).run(
      roleId,
      req.user!.id,
      req.params.id
    );
    writeAudit({
      userId: req.user!.id,
      action: "USER_ROLE_CHANGED",
      entity: "users",
      entityId: req.params.id,
      previousValue: before,
      newValue: { roleId },
    });
    res.json({ data: { id: req.params.id, roleId } });
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/status", (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(["active", "suspended"]) }).parse(req.body);
    db.prepare(`UPDATE users SET status = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`).run(
      status,
      req.user!.id,
      req.params.id
    );
    writeAudit({
      userId: req.user!.id,
      action: "USER_STATUS_CHANGED",
      entity: "users",
      entityId: req.params.id,
      newValue: { status },
    });
    res.json({ data: { id: req.params.id, status } });
  } catch (e) {
    next(e);
  }
});

const passwordSchema = z.object({
  password: z.string().min(8),
});

router.patch("/:id/password", (req, res, next) => {
  try {
    const { password } = passwordSchema.parse(req.body);
    const passwordHash = bcrypt.hashSync(password, 10);
    db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`).run(
      passwordHash,
      req.user!.id,
      req.params.id
    );

    writeAudit({
      userId: req.user!.id,
      action: "USER_PASSWORD_RESET",
      entity: "users",
      entityId: req.params.id,
    });

    res.json({ data: { message: "Password updated successfully" } });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", (req, res, next) => {
  try {
    if (req.params.id === req.user!.id) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    const before = db.prepare(`SELECT id, email, status FROM users WHERE id = ?`).get(req.params.id);
    if (!before) {
      return res.status(404).json({ error: "User not found" });
    }
    db.prepare(`UPDATE users SET status = 'deleted', updated_at = datetime('now'), updated_by = ? WHERE id = ?`).run(
      req.user!.id,
      req.params.id
    );

    writeAudit({
      userId: req.user!.id,
      action: "USER_DELETED",
      entity: "users",
      entityId: req.params.id,
      previousValue: before,
    });

    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
