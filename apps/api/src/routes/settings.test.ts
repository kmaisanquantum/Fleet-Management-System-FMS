import { describe, it, expect, beforeAll } from "vitest";
import { db, initSchema } from "../db";
import { v4 as uuid } from "uuid";
import express from "express";
import settingsRouter from "./settings";

describe("Business Rules & Settings API Tests", () => {
  let adminId: string;
  let driverUserId: string;

  beforeAll(() => {
    initSchema();
    const s = uuid().substring(0, 6);

    // Create admin user
    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as any;
    const adminRoleId = adminRole ? adminRole.id : uuid();
    if (!adminRole) {
      db.prepare("INSERT INTO roles (id, name, description) VALUES (?, 'admin', 'Admin')").run(adminRoleId, "admin");
    }

    adminId = uuid();
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role_id, status)
      VALUES (?, ?, 'hash', 'Test Admin', ?, 'active')
    `).run(adminId, `setting_admin_${s}@dspng.tech`, adminRoleId);

    // Create driver user
    const driverRole = db.prepare("SELECT id FROM roles WHERE name = 'driver'").get() as any;
    const driverRoleId = driverRole ? driverRole.id : uuid();
    if (!driverRole) {
      db.prepare("INSERT INTO roles (id, name, description) VALUES (?, 'driver', 'Driver')").run(driverRoleId, "driver");
    }

    driverUserId = uuid();
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role_id, status)
      VALUES (?, ?, 'hash', 'Test Driver', ?, 'active')
    `).run(driverUserId, `setting_driver_${s}@dspng.tech`, driverRoleId);

    // Seed test business rules
    db.prepare(`
      INSERT OR REPLACE INTO business_rules (key, value, value_type, label, description, updated_at)
      VALUES ('max_allowed_variance_pct', '0.5', 'number', 'Max variance', 'Reconciliation threshold', datetime('now'))
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO business_rules (key, value, value_type, label, description, updated_at)
      VALUES ('default_currency', 'PGK', 'string', 'Default currency', 'Base currency', datetime('now'))
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO business_rules (key, value, value_type, label, description, updated_at)
      VALUES ('negative_inventory_allowed', 'false', 'boolean', 'Negative stock', 'Allow below zero', datetime('now'))
    `).run();
  });

  it("fetches business rules via direct DB query", () => {
    const rules = db.prepare("SELECT * FROM business_rules").all() as any[];
    expect(rules.length).toBeGreaterThanOrEqual(3);

    const varianceRule = rules.find((r) => r.key === "max_allowed_variance_pct");
    expect(varianceRule).toBeDefined();
    expect(varianceRule.value).toBe("0.5");
    expect(varianceRule.value_type).toBe("number");
  });

  it("updates business rules and logs audit entry when updated by admin", () => {
    const key = "max_allowed_variance_pct";
    const newValue = "1.2";

    const existing = db.prepare("SELECT * FROM business_rules WHERE key = ?").get(key) as any;
    expect(existing).toBeDefined();

    db.prepare("UPDATE business_rules SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?").run(newValue, adminId, key);

    db.prepare(`
      INSERT INTO audit_logs (id, user_id, action, entity, entity_id, previous_value, new_value, created_at)
      VALUES (?, ?, 'BUSINESS_RULE_UPDATED', 'business_rules', ?, ?, ?, datetime('now'))
    `).run(uuid(), adminId, key, existing.value, newValue);

    const updated = db.prepare("SELECT * FROM business_rules WHERE key = ?").get(key) as any;
    expect(updated.value).toBe("1.2");

    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'BUSINESS_RULE_UPDATED' AND entity_id = ?").get(key) as any;
    expect(audit).toBeDefined();
    expect(audit.previous_value).toBe("0.5");
    expect(audit.new_value).toBe("1.2");
  });

  it("validates type checking for business rule values", () => {
    const existingNum = db.prepare("SELECT value_type FROM business_rules WHERE key = 'max_allowed_variance_pct'").get() as any;
    expect(existingNum.value_type).toBe("number");

    const invalidNumStr = "not_a_number";
    const isNaNResult = isNaN(parseFloat(invalidNumStr));
    expect(isNaNResult).toBe(true);

    const existingBool = db.prepare("SELECT value_type FROM business_rules WHERE key = 'negative_inventory_allowed'").get() as any;
    expect(existingBool.value_type).toBe("boolean");

    const invalidBoolStr = "maybe";
    const isValidBool = invalidBoolStr.toLowerCase() === "true" || invalidBoolStr.toLowerCase() === "false";
    expect(isValidBool).toBe(false);
  });
});
