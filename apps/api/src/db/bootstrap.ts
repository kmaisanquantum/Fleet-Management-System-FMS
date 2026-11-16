import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { db } from "./index";

export function ensureBootstrapAccounts() {
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@dspng.tech";
  const rawPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || "Admin@2026";

  // Ensure default roles exist
  const rolesToEnsure = [
    { name: "admin", desc: "Systems Admin" },
    { name: "fuel_operator", desc: "Fuel Operator" },
    { name: "driver", desc: "Driver" },
  ];

  const roleMap: Record<string, string> = {};

  for (const role of rolesToEnsure) {
    const existing = db.prepare("SELECT id FROM roles WHERE name = ?").get(role.name) as { id: string } | undefined;
    if (existing) {
      roleMap[role.name] = existing.id;
      db.prepare("UPDATE roles SET description = ? WHERE name = ?").run(role.desc, role.name);
    } else {
      const id = uuid();
      db.prepare("INSERT INTO roles (id, name, description) VALUES (?, ?, ?)").run(id, role.name, role.desc);
      roleMap[role.name] = id;
    }
  }

  const passwordHash = bcrypt.hashSync(rawPassword, 10);

  // Ensure admin user exists and password is idempotent
  const existingAdmin = db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail);
  if (!existingAdmin) {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, full_name, role_id, status)
      VALUES (?, ?, ?, 'Admin User', ?, 'active')
    `).run(uuid(), adminEmail, passwordHash, roleMap["admin"]);
  } else {
    db.prepare(`
      UPDATE users SET password_hash = ?, status = 'active' WHERE email = ?
    `).run(passwordHash, adminEmail);
  }
}
