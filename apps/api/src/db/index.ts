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

  migrateExistingDatabase();
}

/**
 * Adds columns/constraints introduced after the initial release to databases
 * created by older schema versions (CREATE TABLE IF NOT EXISTS will not alter
 * an existing table).
 */
function migrateExistingDatabase() {
  const addColumn = (table: string, column: string, definition: string) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
      }
    } catch (e) {}
  };

  // gps_positions — Teltonika-specific telemetry fields
  addColumn("gps_positions", "ignition_source", "TEXT");
  addColumn("gps_positions", "movement_source", "TEXT");
  addColumn("gps_positions", "gsm_signal", "INTEGER");
  addColumn("gps_positions", "external_voltage_mv", "INTEGER");
  addColumn("gps_positions", "geofence_zone_id", "TEXT");
  addColumn("gps_positions", "trip_odometer", "REAL");
  addColumn("gps_positions", "fuel_level_pct", "REAL");
  addColumn("gps_positions", "engine_rpm", "INTEGER");
  addColumn("gps_positions", "engine_hours", "REAL");
  addColumn("gps_positions", "harsh_event", "TEXT");
  addColumn("gps_positions", "driver_id_tag", "TEXT");
  addColumn("gps_positions", "io_json", "TEXT");

  // gps_positions — rich Teltonika FMB125 telemetry (imei-keyed, idempotent ingest)
  addColumn("gps_positions", "imei", "TEXT");
  addColumn("gps_positions", "sats", "INTEGER");
  addColumn("gps_positions", "fuel_liters", "REAL");

  // gps_devices — vendor/protocol discriminator
  addColumn("gps_devices", "device_type", "TEXT NOT NULL DEFAULT 'meshsat'");

  // vehicles — live-state fields fed by telemetry
  addColumn("vehicles", "current_fuel_level_pct", "REAL");
  addColumn("vehicles", "current_engine_hours", "REAL");

  // Client (tenant) scoping — added after the initial release
  addColumn("users", "client_id", "TEXT REFERENCES clients(id)");
  addColumn("vehicles", "client_id", "TEXT REFERENCES clients(id)");
  addColumn("gps_devices", "client_id", "TEXT REFERENCES clients(id)");

  // Indexes that reference the columns added above (created here so they work
  // on databases that predate those columns).
  runIgnoreErrors("CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_positions_imei_time ON gps_positions(imei, recorded_at) WHERE imei IS NOT NULL;");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_gps_positions_imei ON gps_positions(imei, recorded_at DESC);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_vehicles_client ON vehicles(client_id);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_gps_devices_client ON gps_devices(client_id);");

  // CHECK constraints that gained new allowed values require a table rebuild
  // in SQLite. Rebuild only when the new value is missing from the old DDL.
  rebuildIfCheckMissing(
    "driver_events",
    "harsh_cornering",
    `CREATE TABLE driver_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN ('speeding', 'harsh_braking', 'harsh_accel', 'excessive_idling', 'harsh_cornering', 'crash')),
      vehicle_id TEXT REFERENCES vehicles(id),
      driver_id TEXT REFERENCES drivers(id),
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      value REAL NOT NULL DEFAULT 0,
      lat REAL,
      lon REAL
    );`
  );

  rebuildIfCheckMissing(
    "fleet_exceptions",
    "telemetry",
    `CREATE TABLE fleet_exceptions (
      id TEXT PRIMARY KEY,
      severity TEXT NOT NULL CHECK(severity IN ('critical', 'warning', 'info')),
      category TEXT NOT NULL CHECK(category IN ('fuel', 'gps', 'driver', 'vehicle', 'maintenance', 'route', 'security', 'compliance', 'geofence', 'telemetry')),
      rule_code TEXT NOT NULL,
      vehicle_id TEXT REFERENCES vehicles(id),
      driver_id TEXT REFERENCES drivers(id),
      transaction_id TEXT REFERENCES vehicle_fuel_logs(id),
      gps_position_id TEXT REFERENCES gps_positions(id),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'resolved', 'dismissed')),
      notes TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );`
  );
}

function runIgnoreErrors(sql: string) {
  try {
    db.exec(sql);
  } catch (e) {}
}

function rebuildIfCheckMissing(table: string, requiredValue: string, createSql: string) {
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql?: string } | undefined;
    if (!row?.sql || row.sql.includes(`'${requiredValue}'`)) return;

    const tmp = `${table}__old`;
    const columnNames = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((c) => c.name)
      .join(", ");

    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(`ALTER TABLE ${table} RENAME TO ${tmp};`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${table} (${columnNames}) SELECT ${columnNames} FROM ${tmp};`);
    db.exec(`DROP TABLE ${tmp};`);
    db.exec("PRAGMA foreign_keys = ON;");
  } catch (e) {}
}
