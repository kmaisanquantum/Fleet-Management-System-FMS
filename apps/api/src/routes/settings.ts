import { Router } from "express";
import { z } from "zod";
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

export default router;
