import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { writeAudit } from "../utils/audit";

const router = Router();
router.use(requireAuth);

/**
 * Helper to fetch a business rule value with type parsing and fallback
 */
export function getBusinessRule(key: string, fallbackEnvVar?: string, defaultValue: string = ""): string {
  try {
    const row = db.prepare("SELECT value FROM business_rules WHERE key = ?").get(key) as { value: string } | undefined;
    if (row && row.value !== undefined && row.value !== null) {
      return row.value;
    }
  } catch {}

  if (fallbackEnvVar && process.env[fallbackEnvVar]) {
    return process.env[fallbackEnvVar]!;
  }

  return defaultValue;
}

export function getBusinessRuleNumber(key: string, fallbackEnvVar?: string, defaultValue: number = 0): number {
  const strVal = getBusinessRule(key, fallbackEnvVar, String(defaultValue));
  const num = parseFloat(strVal);
  return isNaN(num) ? defaultValue : num;
}

export function getBusinessRuleBoolean(key: string, fallbackEnvVar?: string, defaultValue: boolean = false): boolean {
  const strVal = getBusinessRule(key, fallbackEnvVar, String(defaultValue)).toLowerCase();
  return strVal === "true" || strVal === "1";
}

/**
 * GET /api/v1/settings
 * Retrieve all business rules
 */
router.get("/", (_req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT br.*, u.full_name as updated_by_name
      FROM business_rules br
      LEFT JOIN users u ON u.id = br.updated_by
      ORDER BY br.key ASC
    `).all();
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

const settingItemSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const updateSettingsSchema = z.object({
  settings: z.array(settingItemSchema).optional(),
}).catchall(z.union([z.string(), z.number(), z.boolean()]));

/**
 * PUT /api/v1/settings
 * Update business rules (Admin only)
 */
router.put("/", requireRole("admin"), (req, res, next) => {
  try {
    let itemsToUpdate: { key: string; value: string }[] = [];

    if (Array.isArray(req.body)) {
      itemsToUpdate = req.body.map((item: any) => ({
        key: String(item.key),
        value: String(item.value),
      }));
    } else if (req.body.settings && Array.isArray(req.body.settings)) {
      itemsToUpdate = req.body.settings.map((item: any) => ({
        key: String(item.key),
        value: String(item.value),
      }));
    } else {
      // Key-value object format
      itemsToUpdate = Object.entries(req.body).map(([key, value]) => ({
        key,
        value: String(value),
      }));
    }

    if (itemsToUpdate.length === 0) {
      return res.status(400).json({ error: "No settings provided to update" });
    }

    const updatedKeys: string[] = [];

    for (const item of itemsToUpdate) {
      const existing = db.prepare("SELECT * FROM business_rules WHERE key = ?").get(item.key) as any;
      if (!existing) {
        return res.status(400).json({ error: `Unknown business rule key: '${item.key}'` });
      }

      // Validate value based on existing value_type
      let cleanValue = item.value;
      if (existing.value_type === "number") {
        const num = parseFloat(item.value);
        if (isNaN(num)) {
          return res.status(400).json({ error: `Invalid number value for setting '${item.key}': '${item.value}'` });
        }
        cleanValue = String(num);
      } else if (existing.value_type === "boolean") {
        const lower = item.value.toLowerCase();
        if (lower !== "true" && lower !== "false" && lower !== "1" && lower !== "0") {
          return res.status(400).json({ error: `Invalid boolean value for setting '${item.key}': '${item.value}'` });
        }
        cleanValue = lower === "true" || lower === "1" ? "true" : "false";
      }

      // Perform update
      db.prepare(`
        UPDATE business_rules
        SET value = ?, updated_at = datetime('now'), updated_by = ?
        WHERE key = ?
      `).run(cleanValue, req.user!.id, item.key);

      writeAudit({
        userId: req.user!.id,
        action: "BUSINESS_RULE_UPDATED",
        entity: "business_rules",
        entityId: item.key,
        previousValue: existing.value,
        newValue: cleanValue,
        reason: `Setting ${item.key} updated to ${cleanValue}`,
      });

      updatedKeys.push(item.key);
    }

    const allSettings = db.prepare("SELECT * FROM business_rules ORDER BY key ASC").all();
    res.json({
      message: `Updated ${updatedKeys.length} settings`,
      data: allSettings,
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * Configurable Teltonika IO feature map
 * (edit to match the FMB125 Configurator without a code change)
 * ------------------------------------------------------------------ */

const ioFeatureSchema = z.object({
  io_id: z.number().int(),
  feature_key: z.string().min(1),
  label: z.string().min(1),
  value_type: z.enum(["event", "scalar", "boolean"]).optional(),
  enabled: z.boolean().optional(),
});

const ioFeatureUpdateSchema = ioFeatureSchema.partial();

/** GET /api/v1/settings/io-features — the IO-ID -> feature mapping. */
router.get("/io-features", (_req, res, next) => {
  try {
    const rows = db.prepare("SELECT * FROM io_feature_map ORDER BY io_id ASC, feature_key ASC").all();
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

/** POST /api/v1/settings/io-features — add an IO mapping (Admin only). */
router.post("/io-features", requireRole("admin"), (req, res, next) => {
  try {
    const parsed = ioFeatureSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid IO feature", details: parsed.error.flatten() });
    const { io_id, feature_key, label, value_type, enabled } = parsed.data;
    const id = uuid();
    db.prepare("INSERT INTO io_feature_map (id, io_id, feature_key, label, value_type, enabled) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, io_id, feature_key, label, value_type ?? "event", enabled === false ? 0 : 1);
    writeAudit({ userId: req.user!.id, action: "IO_FEATURE_CREATED", entity: "io_feature_map", entityId: id, newValue: parsed.data });
    res.status(201).json({ data: db.prepare("SELECT * FROM io_feature_map WHERE id = ?").get(id) });
  } catch (e) {
    next(e);
  }
});

/** PUT /api/v1/settings/io-features/:id — update an IO mapping (Admin only). */
router.put("/io-features/:id", requireRole("admin"), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM io_feature_map WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "IO feature not found" });
    const parsed = ioFeatureUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid IO feature", details: parsed.error.flatten() });
    const next_ = { ...existing, ...parsed.data };
    db.prepare("UPDATE io_feature_map SET io_id = ?, feature_key = ?, label = ?, value_type = ?, enabled = ? WHERE id = ?")
      .run(next_.io_id, next_.feature_key, next_.label, next_.value_type, next_.enabled ? 1 : 0, req.params.id);
    writeAudit({ userId: req.user!.id, action: "IO_FEATURE_UPDATED", entity: "io_feature_map", entityId: req.params.id, previousValue: existing, newValue: parsed.data });
    res.json({ data: db.prepare("SELECT * FROM io_feature_map WHERE id = ?").get(req.params.id) });
  } catch (e) {
    next(e);
  }
});

/** DELETE /api/v1/settings/io-features/:id (Admin only). */
router.delete("/io-features/:id", requireRole("admin"), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM io_feature_map WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "IO feature not found" });
    db.prepare("DELETE FROM io_feature_map WHERE id = ?").run(req.params.id);
    writeAudit({ userId: req.user!.id, action: "IO_FEATURE_DELETED", entity: "io_feature_map", entityId: req.params.id, previousValue: existing });
    res.json({ message: "IO feature deleted" });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ *
 * Configurable Teltonika parameter map (used to build setparam commands)
 * ------------------------------------------------------------------ */

const paramSchema = z.object({
  feature_key: z.string().min(1),
  param_id: z.number().int(),
  description: z.string().optional(),
});

const paramUpdateSchema = paramSchema.partial();

/** GET /api/v1/settings/param-map — the parameter-ID map. */
router.get("/param-map", (_req, res, next) => {
  try {
    const rows = db.prepare("SELECT * FROM param_map ORDER BY feature_key ASC").all();
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

/** POST /api/v1/settings/param-map — add a parameter mapping (Admin only). */
router.post("/param-map", requireRole("admin"), (req, res, next) => {
  try {
    const parsed = paramSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid parameter mapping", details: parsed.error.flatten() });
    const id = uuid();
    db.prepare("INSERT INTO param_map (id, feature_key, param_id, description) VALUES (?, ?, ?, ?)")
      .run(id, parsed.data.feature_key, parsed.data.param_id, parsed.data.description ?? null);
    writeAudit({ userId: req.user!.id, action: "PARAM_MAP_CREATED", entity: "param_map", entityId: id, newValue: parsed.data });
    res.status(201).json({ data: db.prepare("SELECT * FROM param_map WHERE id = ?").get(id) });
  } catch (e) {
    next(e);
  }
});

/** PUT /api/v1/settings/param-map/:id — update a parameter mapping (Admin only). */
router.put("/param-map/:id", requireRole("admin"), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM param_map WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "Parameter mapping not found" });
    const parsed = paramUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid parameter mapping", details: parsed.error.flatten() });
    const next_ = { ...existing, ...parsed.data };
    db.prepare("UPDATE param_map SET feature_key = ?, param_id = ?, description = ? WHERE id = ?")
      .run(next_.feature_key, next_.param_id, next_.description ?? null, req.params.id);
    writeAudit({ userId: req.user!.id, action: "PARAM_MAP_UPDATED", entity: "param_map", entityId: req.params.id, previousValue: existing, newValue: parsed.data });
    res.json({ data: db.prepare("SELECT * FROM param_map WHERE id = ?").get(req.params.id) });
  } catch (e) {
    next(e);
  }
});

/** DELETE /api/v1/settings/param-map/:id (Admin only). */
router.delete("/param-map/:id", requireRole("admin"), (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM param_map WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Parameter mapping not found" });
    db.prepare("DELETE FROM param_map WHERE id = ?").run(req.params.id);
    writeAudit({ userId: req.user!.id, action: "PARAM_MAP_DELETED", entity: "param_map", entityId: req.params.id, previousValue: existing });
    res.json({ message: "Parameter mapping deleted" });
  } catch (e) {
    next(e);
  }
});

export default router;
