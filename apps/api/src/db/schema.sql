-- Fuel Management System Schema (Fleet Focus)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id),
  permission_code TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);

-- Tenant boundary for fleet & telemetry data (separate from the fuel-domain airport_id)
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  airport_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_by TEXT
);

-- Which client(s) a user may see. Client-role users are scoped through this
-- join table (user_clients -> vehicles.client_id); fleet-wide roles see all.
CREATE TABLE IF NOT EXISTS user_clients (
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE IF NOT EXISTS business_rules (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK(value_type IN ('number', 'string', 'boolean')),
  label TEXT,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL, -- critical | warning
  airport_id TEXT,
  asset_type TEXT,
  asset_id TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT REFERENCES users(id),
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  role TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  previous_value TEXT,
  new_value TEXT,
  ip_address TEXT,
  device TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fleet Management Tables
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  vehicle_number TEXT UNIQUE NOT NULL,
  registration_number TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  vehicle_type TEXT NOT NULL,
  chassis_vin TEXT,
  engine_number TEXT,
  colour TEXT,
  fuel_type TEXT NOT NULL,
  department TEXT,
  location TEXT,
  client_id TEXT REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'under_repair', 'disposed')),
  acquisition_date TEXT,
  acquisition_cost REAL,
  current_value REAL,
  ownership TEXT NOT NULL DEFAULT 'owned' CHECK(ownership IN ('owned', 'leased', 'hired', 'other')),
  insurance_policy TEXT,
  insurance_expiry TEXT,
  registration_expiry TEXT,
  tank_capacity_litres REAL DEFAULT 80.0,
  expected_km_per_l REAL DEFAULT 8.0,
  gps_device_id TEXT,
  fuel_card_id TEXT,
  current_odometer REAL DEFAULT 0.0,
  current_latitude REAL,
  current_longitude REAL,
  current_location_name TEXT,
  last_gps_fix_at TEXT,
  -- Wall-clock time of the most recent successful telemetry ingest (offline
  -- watchdog: a vehicle is 'online' when this is within DEVICE_OFFLINE_MINUTES).
  last_seen_at TEXT,
  current_fuel_level_pct REAL,
  current_engine_hours REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  employee_number TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  licence_number TEXT NOT NULL,
  licence_class TEXT,
  licence_expiry TEXT NOT NULL,
  authorisation_status TEXT NOT NULL DEFAULT 'authorised' CHECK(authorisation_status IN ('authorised', 'suspended', 'revoked', 'pending')),
  accident_history TEXT,
  training TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_allocations (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  department TEXT,
  custodian TEXT,
  driver_id TEXT REFERENCES drivers(id),
  allocation_date TEXT NOT NULL,
  return_date TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK(approval_status IN ('pending', 'approved', 'rejected', 'returned')),
  authorisation_status TEXT NOT NULL DEFAULT 'active' CHECK(authorisation_status IN ('active', 'expired', 'revoked')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gps_devices (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT REFERENCES vehicles(id),
  device_identifier TEXT UNIQUE NOT NULL,
  device_type TEXT NOT NULL DEFAULT 'meshsat' CHECK(device_type IN ('meshsat', 'teltonika')),
  -- Hardware model. Drives which UI tabs / IO mappings / capabilities apply.
  device_model TEXT NOT NULL DEFAULT 'FMB125'
    CHECK(device_model IN ('FMB125', 'FMC130', 'FMC650', 'FMB920', 'DUALCAM')),
  -- JSON capability flags: {has_fuel_rs232, has_can_j1939, has_ble_sensors, has_camera, dout_count}
  capabilities TEXT,
  client_id TEXT REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'maintenance')),
  -- Wall-clock time of the most recent successful ingest for this device.
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gps_positions (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  speed REAL NOT NULL DEFAULT 0,
  heading REAL NOT NULL DEFAULT 0,
  ignition INTEGER NOT NULL DEFAULT 0,
  odometer REAL NOT NULL DEFAULT 0,
  altitude_m REAL,
  battery_pct REAL,
  source TEXT NOT NULL DEFAULT 'telemetry',
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  geofence_status TEXT NOT NULL DEFAULT 'inside',
  ignition_source TEXT,
  movement_source TEXT,
  gsm_signal INTEGER,
  external_voltage_mv INTEGER,
  geofence_zone_id TEXT,
  trip_odometer REAL,
  fuel_level_pct REAL,
  engine_rpm INTEGER,
  engine_hours REAL,
  harsh_event TEXT,
  driver_id_tag TEXT,
  io_json TEXT,
  imei TEXT,
  sats INTEGER,
  fuel_liters REAL
);

-- Rich telemetry records (one row per device fix). Idempotent ingest is
-- enforced by UNIQUE(imei, recorded_at) with INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS telemetry_records (
  id TEXT PRIMARY KEY,
  imei TEXT NOT NULL,
  vehicle_id TEXT REFERENCES vehicles(id),
  recorded_at TEXT NOT NULL,
  lat REAL,
  lon REAL,
  sats INTEGER,
  speed_kmh REAL,
  heading REAL,
  ignition INTEGER,
  fuel_liters REAL,
  -- Normalized FMB125 engineering values (raw IO kept in io_json).
  ext_voltage_v REAL,
  int_battery_v REAL,
  odometer_km REAL,
  movement INTEGER,
  -- Driver identity from the iButton reader (IO 78) when present.
  driver_id TEXT,
  -- Raw iButton/driver tag id (IO 78); kept separate from any future driver FK.
  driver_tag_id TEXT,
  io_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (imei, recorded_at)
);

-- Outbound device commands (Codec 12) queued for the tracker's next TCP session.
CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY,
  imei TEXT NOT NULL,
  vehicle_id TEXT REFERENCES vehicles(id),
  command_type TEXT NOT NULL CHECK (command_type IN ('setparam', 'setdigout', 'diagnostic', 'raw', 'camreq')),
  payload_json TEXT,
  -- Exact Codec 12 string sent to the bridge (e.g. `setparam 1580:80`).
  raw_command TEXT,
  -- queued -> sent -> applied, or failed / expired (TTL elapsed). 'acked' and
  -- 'acknowledged' are legacy synonyms kept for existing rows/readers.
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'applied', 'acked', 'acknowledged', 'failed', 'expired')),
  requested_by TEXT REFERENCES users(id),
  -- Alias of requested_by used by the bridge/audit contract.
  created_by TEXT REFERENCES users(id),
  -- Operator-supplied justification (required for an ignition cut).
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  response_text TEXT,
  -- Structured/raw tracker response (mirrors response_text for the bridge API).
  response_payload TEXT,
  -- Set when the tracker acknowledges the command (Codec 12 reply).
  acked_at TEXT
);

-- Latest known remote-configuration state per device parameter. `desired_value`
-- is the latest requested value; `applied_value` is the last value confirmed by
-- the tracker. The command trail remains in device_commands.
CREATE TABLE IF NOT EXISTS device_config_state (
  id TEXT PRIMARY KEY,
  imei TEXT NOT NULL,
  vehicle_id TEXT REFERENCES vehicles(id),
  param_id INTEGER NOT NULL,
  feature_key TEXT,
  value TEXT,
  desired_value TEXT,
  applied_value TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'applied', 'failed')),
  command_id TEXT REFERENCES device_commands(id),
  requested_by TEXT REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  response_text TEXT,
  -- Preset metadata for writes applied through a named profile.
  preset_key TEXT,
  preset_metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (imei, param_id)
);

-- Media (camera stills, clips) captured by a device and reported by the relay
-- via POST /api/telemetry/media. Listed per-device in the UI Media tab.
CREATE TABLE IF NOT EXISTS device_media (
  id TEXT PRIMARY KEY,
  device_id TEXT REFERENCES gps_devices(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  client_id TEXT REFERENCES clients(id),
  -- What triggered the capture (e.g. panic, ignition, request, motion).
  trigger_type TEXT NOT NULL,
  camera_channel INTEGER,
  media_type TEXT NOT NULL,
  storage_url TEXT NOT NULL,
  captured_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Configurable IO-ID -> feature mapping (edit to match the FMB125 Configurator).
CREATE TABLE IF NOT EXISTS io_feature_map (
  id TEXT PRIMARY KEY,
  io_id INTEGER NOT NULL,
  feature_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'event' CHECK (value_type IN ('event', 'scalar', 'boolean')),
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Multiplier applied to the raw IO value (e.g. fuel counters report
  -- millilitres, so scale 0.001 converts them to litres).
  scale_factor REAL NOT NULL DEFAULT 1,
  -- NULL device_model = applies to all models.
  device_model TEXT,
  -- Engineering unit label for the scaled value (e.g. V, km, L).
  unit TEXT,
  UNIQUE (io_id, feature_key)
);

-- Configurable Teltonika parameter-ID map used to build setparam commands.
CREATE TABLE IF NOT EXISTS param_map (
  id TEXT PRIMARY KEY,
  feature_key TEXT NOT NULL,
  param_id INTEGER NOT NULL,
  description TEXT,
  -- NULL device_model = applies to all models.
  device_model TEXT,
  -- Engineering unit label for the parameter value (e.g. km/h, s, m).
  unit TEXT,
  UNIQUE (feature_key, param_id)
);

CREATE TABLE IF NOT EXISTS fuel_cards (
  id TEXT PRIMARY KEY,
  card_number TEXT UNIQUE NOT NULL,
  vehicle_id TEXT REFERENCES vehicles(id),
  authorised_driver_id TEXT REFERENCES drivers(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'blocked', 'cancelled')),
  limits TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fuel_stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  station_type TEXT NOT NULL DEFAULT 'station' CHECK(station_type IN ('station', 'depot')),
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS geofences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Owning tenant; NULL = global / all clients.
  client_id TEXT REFERENCES clients(id),
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius_meters REAL NOT NULL DEFAULT 1000,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('speeding', 'harsh_braking', 'harsh_accel', 'excessive_idling', 'harsh_cornering', 'crash')),
  vehicle_id TEXT REFERENCES vehicles(id),
  driver_id TEXT REFERENCES drivers(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  value REAL NOT NULL DEFAULT 0,
  lat REAL,
  lon REAL
);

CREATE TABLE IF NOT EXISTS vehicle_fuel_logs (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver_id TEXT REFERENCES drivers(id),
  date TEXT NOT NULL,
  time TEXT,
  station TEXT,
  fuel_type TEXT NOT NULL,
  litres REAL NOT NULL,
  cost_per_litre REAL NOT NULL,
  total_cost REAL NOT NULL,
  odometer_reading REAL NOT NULL,
  payment_method TEXT,
  receipt_ref TEXT,
  l_per_100km REAL,
  km_per_l REAL,
  cost_per_km REAL,
  fuel_card_id TEXT REFERENCES fuel_cards(id),
  station_id TEXT REFERENCES fuel_stations(id),
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('card', 'depot', 'manual')),
  gps_verified INTEGER NOT NULL DEFAULT 0,
  reconciliation_status TEXT NOT NULL DEFAULT 'pending' CHECK(reconciliation_status IN ('verified', 'exception', 'pending')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fleet_exceptions (
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
  -- Set when an operator acknowledges the exception from the alert-rules UI.
  acknowledged_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS vehicle_trips (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver_id TEXT REFERENCES drivers(id),
  date TEXT NOT NULL,
  time_out TEXT,
  time_in TEXT,
  start_location TEXT NOT NULL,
  destination TEXT NOT NULL,
  purpose TEXT,
  begin_odometer REAL NOT NULL,
  end_odometer REAL NOT NULL,
  total_km REAL NOT NULL,
  odometer_anomaly INTEGER NOT NULL DEFAULT 0,
  authorising_officer TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_inspections (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  inspector_id TEXT REFERENCES users(id),
  inspector_name TEXT NOT NULL,
  inspection_date TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('pass', 'fail', 'requires_attention')),
  checklist TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_maintenance (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  maintenance_type TEXT NOT NULL CHECK(maintenance_type IN ('scheduled_service', 'unscheduled_repair', 'inspection_fix', 'other')),
  description TEXT NOT NULL,
  scheduled_date TEXT,
  completed_date TEXT,
  technician TEXT,
  work_performed TEXT,
  parts TEXT,
  cost REAL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_breakdowns (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver_id TEXT REFERENCES drivers(id),
  breakdown_date TEXT NOT NULL,
  location TEXT NOT NULL,
  description TEXT NOT NULL,
  towing_required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported', 'in_repair', 'resolved')),
  resolution_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_accidents (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver_id TEXT REFERENCES drivers(id),
  accident_date TEXT NOT NULL,
  location TEXT,
  description TEXT,
  damage_severity TEXT,
  photo_urls TEXT,
  status TEXT NOT NULL DEFAULT 'reported',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_disposals (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  disposal_date TEXT NOT NULL,
  disposal_method TEXT,
  disposal_amount REAL,
  reason TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------ --
-- Fleet-expansion tables (schema foundations: tables + indexes + FKs).
-- No business logic yet — populated by later feature work.
-- ------------------------------------------------------------------ --

-- Automatic trips derived from telemetry (distinct from the manual
-- vehicle_trips log, which is left untouched).
CREATE TABLE IF NOT EXISTS telemetry_trips (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT REFERENCES vehicles(id),
  device_id TEXT REFERENCES gps_devices(id),
  client_id TEXT REFERENCES clients(id),
  driver_tag_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_lat REAL,
  start_lon REAL,
  end_lat REAL,
  end_lon REAL,
  distance_km REAL,
  duration_sec INTEGER,
  max_speed_kmh REAL,
  idle_sec INTEGER,
  fuel_used_liters REAL,
  safety_score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-tenant configurable alert rules (thresholds / severities / toggles).
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('critical', 'warning', 'info')),
  config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Preventive-maintenance schedules (odometer / engine-hours / calendar).
CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  client_id TEXT REFERENCES clients(id),
  interval_type TEXT NOT NULL CHECK(interval_type IN ('odometer_km', 'engine_hours', 'calendar')),
  interval_value REAL NOT NULL,
  last_done_at TEXT,
  last_done_odometer REAL,
  next_due TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Work orders raised against a maintenance schedule.
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  schedule_id TEXT REFERENCES maintenance_schedules(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  client_id TEXT REFERENCES clients(id),
  description TEXT NOT NULL,
  cost_pgk REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'completed', 'cancelled')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

-- Dispatch jobs with proof-of-delivery (signature / photo / GPS).
CREATE TABLE IF NOT EXISTS dispatch_jobs (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  driver_id TEXT REFERENCES drivers(id),
  stops_json TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  pod_signature_url TEXT,
  pod_photo_url TEXT,
  pod_lat REAL,
  pod_lon REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Public read-only share links for a vehicle's live location (expiring token).
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT REFERENCES vehicles(id),
  client_id TEXT REFERENCES clients(id),
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-client module subscriptions (which product modules a tenant has enabled).
CREATE TABLE IF NOT EXISTS client_subscriptions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  module TEXT NOT NULL CHECK(module IN ('tracking', 'fuel_immobilizer', 'camera_adas', 'maintenance_dispatch')),
  vehicle_quota INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, module)
);

-- View for current vehicle status
DROP VIEW IF EXISTS vehicle_status_view;
CREATE VIEW IF NOT EXISTS vehicle_status_view AS
SELECT
  v.id AS vehicle_id,
  v.vehicle_number,
  v.registration_number,
  v.status AS raw_vehicle_status,
  gp.speed,
  gp.heading,
  gp.ignition,
  gp.recorded_at AS last_gps_fix,
  CASE
    WHEN v.status = 'under_repair' THEN 'under_maintenance'
    WHEN v.status = 'inactive' OR v.status = 'disposed' THEN 'unassigned'
    WHEN gp.recorded_at IS NULL OR datetime(gp.recorded_at) < datetime('now', '-2 hours') THEN 'offline'
    WHEN gp.ignition = 1 AND gp.speed > 5 THEN 'moving'
    WHEN gp.ignition = 1 AND gp.speed <= 5 THEN 'idle'
    ELSE 'stationary'
  END AS computed_status
FROM vehicles v
LEFT JOIN (
  SELECT p1.*
  FROM gps_positions p1
  INNER JOIN (
    SELECT vehicle_id, MAX(recorded_at) as max_rec
    FROM gps_positions
    GROUP BY vehicle_id
  ) p2 ON p1.vehicle_id = p2.vehicle_id AND p1.recorded_at = p2.max_rec
) gp ON v.id = gp.vehicle_id;

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);
CREATE INDEX IF NOT EXISTS idx_fuel_logs_vehicle ON vehicle_fuel_logs(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle ON vehicle_trips(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_gps_positions_vehicle ON gps_positions(vehicle_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_exceptions_status ON fleet_exceptions(status, severity);
CREATE INDEX IF NOT EXISTS idx_user_clients_user ON user_clients(user_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_records_vehicle ON telemetry_records(vehicle_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_records_imei ON telemetry_records(imei, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_imei ON device_commands(imei, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_config_state_imei ON device_config_state(imei, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_media_device ON device_media(device_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_media_captured ON device_media(captured_at DESC);
-- Fleet-expansion indexes
CREATE INDEX IF NOT EXISTS idx_telemetry_trips_vehicle ON telemetry_trips(vehicle_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_trips_client ON telemetry_trips(client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_rules_client ON alert_rules(client_id, alert_type);
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_vehicle ON maintenance_schedules(vehicle_id, interval_type);
CREATE INDEX IF NOT EXISTS idx_work_orders_vehicle ON work_orders(vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_client ON dispatch_jobs(client_id, status);
CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
CREATE INDEX IF NOT EXISTS idx_client_subscriptions_client ON client_subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_geofences_client ON geofences(client_id);

-- Default IO feature map (Teltonika FMB125 AVL element ids). Starting defaults
-- only — edit to match the device's configured IO list (see Settings screen).
-- The GNSS fuel counters (IO 12/13) report millilitres, hence scale_factor
-- 0.001 so the ingest fallback stores litres in fuel_liters.
INSERT OR IGNORE INTO io_feature_map (id, io_id, feature_key, label, value_type, scale_factor, unit) VALUES
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
  ('iof-ibutton',         78,  'ibutton',           'iButton / Driver ID Read',         'scalar',  1,     NULL);

-- Default Teltonika parameter map (parameter ids are device-configurable).
INSERT OR IGNORE INTO param_map (id, feature_key, param_id, description) VALUES
  ('pm-overspeed-threshold', 'overspeed_threshold',   1580, 'Overspeeding threshold (km/h)'),
  ('pm-idling-timeout',      'idling_timeout',        1581, 'Excessive idling timeout (seconds)'),
  ('pm-eco-driving',         'eco_driving_threshold', 1582, 'Eco (green) driving sensitivity'),
  ('pm-geofence-radius',     'geofence_radius',       2051, 'Auto geofence radius (metres)'),
  ('pm-immobilizer-dout',    'immobilizer_dout',      1028, 'DOUT1 / immobiliser control'),
  -- Remote-configuration presets. These are seeded defaults; verify the IDs
  -- against the tracker firmware in Settings → Teltonika Parameter Map.
  ('pm-reporting-interval',  'reporting_interval',    100,  'Periodic data-send interval (seconds)'),
  ('pm-data-acq-ign-on',     'data_acquisition_ignition_on',  104, 'Data acquisition period with ignition ON (seconds)'),
  ('pm-data-acq-ign-off',    'data_acquisition_ignition_off', 102, 'Data acquisition period with ignition OFF (seconds)'),
  ('pm-ignition-source',     'ignition_source',       1000, 'Ignition source selection'),
  ('pm-digital-output',      'digital_output_control', 1028, 'Digital output (DOUT1) control');
