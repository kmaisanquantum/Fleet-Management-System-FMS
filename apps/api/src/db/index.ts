import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// NOTE: SQLite is used here to make the MVP runnable without external infra.
// Production deployment uses PostgreSQL — see /database/migrations/001_init.sql
// which defines the equivalent schema with proper UUID/TIMESTAMP/NUMERIC types.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data/fms.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initSchema() {
  const candidatePaths = [
    path.join(__dirname, "schema.sql"),
    path.join(__dirname, "../src/db/schema.sql"),
    path.join(__dirname, "../../src/db/schema.sql"),
    path.join(process.cwd(), "apps/api/src/db/schema.sql")
  ];

  let schemaPath: string | undefined;
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      schemaPath = candidate;
      break;
    }
  }

  if (!schemaPath) {
    throw new Error(`Failed to locate schema.sql. Checked paths: ${candidatePaths.join(", ")}`);
  }

  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  // Check & migrate columns for existing SQLite databases
  const ensureColumn = (table: string, column: string, definition: string) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (cols.length > 0 && !cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
      }
    } catch (e) {}
  };

  try {
    const gpsCols = db.prepare("PRAGMA table_info(gps_positions)").all() as { name: string }[];
    const colNames = gpsCols.map((c) => c.name);

    if (!colNames.includes("altitude_m")) {
      db.exec("ALTER TABLE gps_positions ADD COLUMN altitude_m REAL;");
    }
    if (!colNames.includes("battery_pct")) {
      db.exec("ALTER TABLE gps_positions ADD COLUMN battery_pct REAL;");
    }
    if (!colNames.includes("source")) {
      db.exec("ALTER TABLE gps_positions ADD COLUMN source TEXT NOT NULL DEFAULT 'telemetry';");
    }
  } catch (e) {}

  // Driver Portal migrations (columns added to pre-existing tables)
  ensureColumn("users", "driver_id", "TEXT REFERENCES drivers(id)");
  ensureColumn("vehicle_inspections", "driver_id", "TEXT REFERENCES drivers(id)");
  ensureColumn("vehicle_inspections", "photo_urls", "TEXT");
  ensureColumn("vehicle_inspections", "cleared", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("vehicle_maintenance", "driver_id", "TEXT REFERENCES drivers(id)");
  ensureColumn("vehicle_maintenance", "requested_by", "TEXT REFERENCES users(id)");
  ensureColumn("vehicle_fuel_logs", "receipt_url", "TEXT");
}
