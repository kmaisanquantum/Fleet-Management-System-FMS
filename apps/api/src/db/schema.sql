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

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL, -- critical | warning
  airport_id TEXT,
  asset_type TEXT,
  asset_id TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
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
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'maintenance')),
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
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  geofence_status TEXT NOT NULL DEFAULT 'inside'
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
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius_meters REAL NOT NULL DEFAULT 1000,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('speeding', 'harsh_braking', 'harsh_accel', 'excessive_idling')),
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
  category TEXT NOT NULL CHECK(category IN ('fuel', 'gps', 'driver', 'vehicle', 'maintenance', 'route', 'security', 'compliance')),
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

-- View for current vehicle status
DROP VIEW IF EXISTS vehicle_status_view;
CREATE VIEW vehicle_status_view AS
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
