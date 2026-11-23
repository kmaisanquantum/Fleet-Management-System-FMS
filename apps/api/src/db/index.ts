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

/**
 * Default capability profile for the Teltonika FMB125 (RS232 fuel probe, no
 * CAN/BLE/camera, two digital outputs). Stored as JSON on `gps_devices.capabilities`.
 */
export const FMB125_CAPABILITIES = {
  has_fuel_rs232: true,
  has_can_j1939: false,
  has_ble_sensors: false,
  has_camera: false,
  dout_count: 2,
} as const;

export const FMB125_CAPABILITIES_JSON = JSON.stringify(FMB125_CAPABILITIES);

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

  // schema.sql's seed statements reference columns that post-date tables on an
  // existing database (CREATE TABLE IF NOT EXISTS is a no-op there). Ensure
  // those columns exist before the schema script runs so its seeds don't fail.
  addColumn("io_feature_map", "scale_factor", "REAL NOT NULL DEFAULT 1");

  db.exec(schema);

  migrateExistingDatabase();
}

/**
 * Adds a column to an existing table when it is missing. Safe to call before
 * or after the table exists (a missing table is created fresh by schema.sql).
 */
function addColumn(table: string, column: string, definition: string) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  } catch (e) {}
}

/**
 * Adds columns/constraints introduced after the initial release to databases
 * created by older schema versions (CREATE TABLE IF NOT EXISTS will not alter
 * an existing table).
 */
function migrateExistingDatabase() {
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

  // telemetry_records — normalized FMB125 engineering values (raw IO in io_json).
  addColumn("telemetry_records", "ext_voltage_v", "REAL");
  addColumn("telemetry_records", "int_battery_v", "REAL");
  addColumn("telemetry_records", "odometer_km", "REAL");
  addColumn("telemetry_records", "movement", "INTEGER");
  addColumn("telemetry_records", "driver_id", "TEXT");
  addColumn("telemetry_records", "heading", "REAL");
  addColumn("telemetry_records", "driver_tag_id", "TEXT");

  // gps_devices — vendor/protocol discriminator
  addColumn("gps_devices", "device_type", "TEXT NOT NULL DEFAULT 'meshsat'");

  // gps_devices — hardware profile (model + JSON capability flags) + offline watchdog
  addColumn("gps_devices", "device_model", "TEXT DEFAULT 'FMB125'");
  addColumn("gps_devices", "capabilities", "TEXT");
  addColumn("gps_devices", "last_seen_at", "TEXT");

  // io_feature_map / param_map — per-model mapping + engineering unit label.
  addColumn("io_feature_map", "device_model", "TEXT");
  addColumn("io_feature_map", "unit", "TEXT");
  addColumn("param_map", "device_model", "TEXT");
  addColumn("param_map", "unit", "TEXT");

  // vehicles — live-state fields fed by telemetry
  addColumn("vehicles", "current_fuel_level_pct", "REAL");
  addColumn("vehicles", "current_engine_hours", "REAL");
  // Offline watchdog: updated on every successful ingest.
  addColumn("vehicles", "last_seen_at", "TEXT");

  // device_commands — operator reason + tracker-ack timestamp (Codec 12 replies).
  addColumn("device_commands", "reason", "TEXT");
  addColumn("device_commands", "acked_at", "TEXT");

  // Client (tenant) scoping — vehicles/devices carry the tenant id; users are
  // mapped to clients through the user_clients join table.
  addColumn("vehicles", "client_id", "TEXT REFERENCES clients(id)");
  addColumn("gps_devices", "client_id", "TEXT REFERENCES clients(id)");

  // Typed, source-tagged alerts (telemetry events: overspeed, geofence_entry/
  // exit, idling, power_unplug, towing, crash, refuel, fuel_drain).
  addColumn("fleet_exceptions", "type", "TEXT");
  addColumn("fleet_exceptions", "source", "TEXT");
  addColumn("alerts", "type", "TEXT");
  addColumn("alerts", "source", "TEXT");

  // user_clients join table (created here so it exists on databases that
  // predate migration 004), then backfilled from the legacy users.client_id
  // column when present.
  runIgnoreErrors(`CREATE TABLE IF NOT EXISTS user_clients (
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL REFERENCES clients(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, client_id)
  );`);
  try {
    const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    if (userCols.some((c) => c.name === "client_id")) {
      runIgnoreErrors(
        "INSERT OR IGNORE INTO user_clients (user_id, client_id) SELECT id, client_id FROM users WHERE client_id IS NOT NULL;"
      );
    }
  } catch (e) {}

  // Rich telemetry + device-command + configurable IO/param tables (created
  // here so they exist on databases that predate migration 005).
  runIgnoreErrors(`CREATE TABLE IF NOT EXISTS telemetry_records (
    id TEXT PRIMARY KEY,
    imei TEXT NOT NULL,
    vehicle_id TEXT REFERENCES vehicles(id),
    recorded_at TEXT NOT NULL,
    lat REAL,
    lon REAL,
    sats INTEGER,
    speed_kmh REAL,
    ignition INTEGER,
    fuel_liters REAL,
    ext_voltage_v REAL,
    int_battery_v REAL,
    odometer_km REAL,
    movement INTEGER,
    driver_id TEXT,
    io_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (imei, recorded_at)
  );`);
  runIgnoreErrors(`CREATE TABLE IF NOT EXISTS device_commands (
    id TEXT PRIMARY KEY,
    imei TEXT NOT NULL,
    vehicle_id TEXT REFERENCES vehicles(id),
    command_type TEXT NOT NULL CHECK (command_type IN ('setparam', 'setdigout', 'diagnostic', 'raw', 'camreq')),
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'acked', 'acknowledged', 'failed')),
    requested_by TEXT REFERENCES users(id),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT,
    response_text TEXT,
    acked_at TEXT
  );`);
  runIgnoreErrors(`CREATE TABLE IF NOT EXISTS device_media (
    id TEXT PRIMARY KEY,
    device_id TEXT REFERENCES gps_devices(id),
    vehicle_id TEXT REFERENCES vehicles(id),
    client_id TEXT REFERENCES clients(id),
    trigger_type TEXT NOT NULL,
    camera_channel INTEGER,
    media_type TEXT NOT NULL,
    storage_url TEXT NOT NULL,
    captured_at TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  runIgnoreErrors(`CREATE TABLE IF NOT EXISTS io_feature_map (
    id TEXT PRIMARY KEY,
    io_id INTEGER NOT NULL,
    feature_key TEXT NOT NULL,
    label TEXT NOT NULL,
    value_type TEXT NOT NULL DEFAULT 'event' CHECK (value_type IN ('event', 'scalar', 'boolean')),
    enabled INTEGER NOT NULL DEFAULT 1,
    scale_factor REAL NOT NULL DEFAULT 1,
    device_model TEXT,
    unit TEXT,
    UNIQUE (io_id, feature_key)
  );`);
  runIgnoreErrors(`CREATE TABLE IF NOT EXISTS param_map (
    id TEXT PRIMARY KEY,
    feature_key TEXT NOT NULL,
    param_id INTEGER NOT NULL,
    description TEXT,
    device_model TEXT,
    unit TEXT,
    UNIQUE (feature_key, param_id)
  );`);

  // Reference defaults for the IO feature map and Teltonika parameter map.
  // INSERT OR IGNORE keeps operator edits intact across restarts.
  runIgnoreErrors(`INSERT OR IGNORE INTO io_feature_map (id, io_id, feature_key, label, value_type, scale_factor, unit) VALUES
    ('iof-fuel-counter-12', 12,  'fuel_counter',      'GNSS Fuel Counter (primary)',      'scalar',  0.001, 'L'),
    ('iof-fuel-counter-13', 13,  'fuel_counter',      'GNSS Fuel Counter (secondary)',    'scalar',  0.001, 'L'),
    ('iof-odometer',        16,  'odometer',          'Odometer',                         'scalar',  0.001, 'km'),
    ('iof-external-voltage', 66, 'external_voltage',  'External Voltage',                 'scalar',  0.001, 'V'),
    ('iof-internal-battery', 67, 'internal_battery',  'Internal Battery',                 'scalar',  0.001, 'V'),
    ('iof-movement',        240, 'movement',          'Movement',                         'boolean', 1,     NULL),
    ('iof-overspeed',       255, 'overspeed',         'Overspeeding',                     'event',   1,     NULL),
    ('iof-eco-accel',       253, 'eco_accel',         'Eco Driving — Harsh Acceleration', 'event',   1,     NULL),
    ('iof-eco-brake',       254, 'eco_brake',         'Eco Driving — Harsh Braking',      'event',   1,     NULL),
    ('iof-idling',          251, 'idling',            'Excessive Idling',                 'event',   1,     NULL),
    ('iof-unplug',          252, 'power_unplug',      'Power Unplug / Tamper',            'event',   1,     NULL),
    ('iof-towing',          246, 'towing',            'Towing Detected',                  'event',   1,     NULL),
    ('iof-crash',           247, 'crash',             'Crash Detection',                  'event',   1,     NULL),
    ('iof-geofence-auto',   175, 'geofence_auto',     'Auto / Manual Geofence',           'event',   1,     NULL),
    ('iof-geofence-zone',   174, 'geofence_zone',     'Geofence Zone Event (IO 155-174)', 'event',   1,     NULL),
    ('iof-ignition',        239, 'ignition',          'Ignition State',                   'boolean', 1,     NULL),
    ('iof-immobilizer',     179, 'immobilizer',       'DOUT1 / Immobilizer',              'boolean', 1,     NULL),
    ('iof-dout-ignition',   179, 'dout_ignition',     'DOUT Driven by Ignition',          'boolean', 1,     NULL),
    ('iof-jamming',         249, 'jamming',           'Network Jamming',                  'event',   1,     NULL),
    ('iof-ibutton',         78,  'ibutton',           'iButton / Driver ID Read',         'scalar',  1,     NULL);`);
  // Backfill engineering-unit labels on rows created before the `unit` column
  // existed (schema.sql's INSERT OR IGNORE no-ops on an existing row).
  runIgnoreErrors("UPDATE io_feature_map SET unit = 'km' WHERE io_id = 16 AND (unit IS NULL OR unit = '');");
  runIgnoreErrors("UPDATE io_feature_map SET unit = 'V' WHERE io_id IN (66, 67) AND (unit IS NULL OR unit = '');");

  // Backfill device profiles: every pre-existing device row defaults to FMB125
  // with the standard 2-DOUT capability profile.
  runIgnoreErrors("UPDATE gps_devices SET device_model = 'FMB125' WHERE device_model IS NULL OR device_model = '';");
  db.prepare("UPDATE gps_devices SET capabilities = ? WHERE capabilities IS NULL OR capabilities = ''").run(FMB125_CAPABILITIES_JSON);
  runIgnoreErrors(`INSERT OR IGNORE INTO param_map (id, feature_key, param_id, description) VALUES
    ('pm-overspeed-threshold', 'overspeed_threshold',   1580, 'Overspeeding threshold (km/h)'),
    ('pm-idling-timeout',      'idling_timeout',        1581, 'Excessive idling timeout (seconds)'),
    ('pm-eco-driving',         'eco_driving_threshold', 1582, 'Eco (green) driving sensitivity'),
    ('pm-geofence-radius',     'geofence_radius',       2051, 'Auto geofence radius (metres)'),
    ('pm-immobilizer-dout',    'immobilizer_dout',      1028, 'DOUT1 / immobiliser control');`);

  // Indexes that reference the columns added above (created here so they work
  // on databases that predate those columns).
  runIgnoreErrors("CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_positions_imei_time ON gps_positions(imei, recorded_at) WHERE imei IS NOT NULL;");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_gps_positions_imei ON gps_positions(imei, recorded_at DESC);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_telemetry_records_vehicle ON telemetry_records(vehicle_id, recorded_at DESC);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_telemetry_records_imei ON telemetry_records(imei, recorded_at DESC);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_device_commands_imei ON device_commands(imei, created_at DESC);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_device_media_device ON device_media(device_id, captured_at DESC);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_device_media_captured ON device_media(captured_at DESC);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_vehicles_client ON vehicles(client_id);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_gps_devices_client ON gps_devices(client_id);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_user_clients_user ON user_clients(user_id);");
  runIgnoreErrors("CREATE INDEX IF NOT EXISTS idx_fleet_exceptions_type ON fleet_exceptions(type);");

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
      type TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'resolved', 'dismissed')),
      notes TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );`
  );

  // Device commands gained a 'diagnostic' type (read-only getinfo/getgps/...)
  // and an 'acknowledged' status (tracker Codec 12 reply), plus `reason` /
  // `acked_at`. A later release added the 'camreq' (camera request) type. The
  // rebuild adds whichever CHECK value is missing; `reason`/`acked_at` are
  // added beforehand by addColumn() so the copy below stays column-complete.
  const deviceCommandsCreateSql = `CREATE TABLE device_commands (
      id TEXT PRIMARY KEY,
      imei TEXT NOT NULL,
      vehicle_id TEXT REFERENCES vehicles(id),
      command_type TEXT NOT NULL CHECK (command_type IN ('setparam', 'setdigout', 'diagnostic', 'raw', 'camreq')),
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'acked', 'acknowledged', 'failed')),
      requested_by TEXT REFERENCES users(id),
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      response_text TEXT,
      acked_at TEXT
    );`;
  rebuildIfCheckMissing("device_commands", "acknowledged", deviceCommandsCreateSql);
  rebuildIfCheckMissing("device_commands", "camreq", deviceCommandsCreateSql);
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
