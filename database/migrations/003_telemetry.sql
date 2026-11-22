-- Fleet Management System — Production Schema (PostgreSQL)
-- Migration 003: consolidated Teltonika telemetry schema + FMB125 device seeds.
--
-- A single, self-contained telemetry migration for non-SQLite (PostgreSQL)
-- deployments. It mirrors the telemetry tables that the runnable SQLite demo
-- creates in apps/api/src/db/schema.sql:
--
--   clients, user_clients, telemetry_records, device_commands,
--   io_feature_map, param_map
--
-- plus the gps_positions / gps_devices / vehicles columns the ingest path writes,
-- the default IO & parameter maps, and the two seeded Teltonika FMB125 trackers
-- (IMEI 354018115690145 → V-101, 354018115694907 → V-102).
--
-- Idempotent: every statement is CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS / ON CONFLICT, so it is safe on a fresh database and when the
-- equivalent statements in migrations 004/005 have already run. It does NOT
-- touch the SQLite auto-migration path (apps/api/src/db/index.ts → schema.sql).

-- ------------------------------------------------------------------ --
-- Tenant boundary (clients) + client-role scoping (user_clients)
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_clients (
  user_id UUID NOT NULL REFERENCES users(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id)
);

ALTER TABLE vehicles    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);
ALTER TABLE gps_devices ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);
ALTER TABLE users       ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);

-- ------------------------------------------------------------------ --
-- Device / position / vehicle columns written by the telemetry ingest path
-- ------------------------------------------------------------------ --
ALTER TABLE gps_devices
  ADD COLUMN IF NOT EXISTS device_type TEXT NOT NULL DEFAULT 'meshsat'
    CHECK (device_type IN ('meshsat', 'teltonika'));

ALTER TABLE gps_positions
  ADD COLUMN IF NOT EXISTS imei TEXT,
  ADD COLUMN IF NOT EXISTS sats INTEGER,
  ADD COLUMN IF NOT EXISTS fuel_liters NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS gsm_signal INTEGER,
  ADD COLUMN IF NOT EXISTS io_json JSONB;

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS current_fuel_level_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS current_engine_hours NUMERIC(12,2);

-- Idempotent ingest: at most one position per device per timestamp
CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_positions_imei_time
  ON gps_positions(imei, recorded_at) WHERE imei IS NOT NULL;

-- ------------------------------------------------------------------ --
-- Rich telemetry records (one row per device fix). Idempotent ingest is
-- enforced by UNIQUE(imei, recorded_at) with ON CONFLICT DO NOTHING.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS telemetry_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imei TEXT NOT NULL,
  vehicle_id UUID REFERENCES vehicles(id),
  recorded_at TIMESTAMPTZ NOT NULL,
  lat NUMERIC(10,6),
  lon NUMERIC(10,6),
  sats INTEGER,
  speed_kmh NUMERIC(6,2),
  ignition BOOLEAN,
  fuel_liters NUMERIC(10,2),
  io_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (imei, recorded_at)
);

-- ------------------------------------------------------------------ --
-- Outbound device commands (Codec 12), queued for the tracker's next TCP
-- session via the meshsat.dspng.space VPS endpoint (POST /api/cmd).
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS device_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imei TEXT NOT NULL,
  vehicle_id UUID REFERENCES vehicles(id),
  command_type TEXT NOT NULL CHECK (command_type IN ('setparam', 'setdigout', 'raw')),
  payload_json JSONB,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'acked', 'failed')),
  requested_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  response_text TEXT
);

-- ------------------------------------------------------------------ --
-- Configurable IO-ID -> feature mapping + Teltonika parameter map
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS io_feature_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  io_id INTEGER NOT NULL,
  feature_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'event' CHECK (value_type IN ('event', 'scalar', 'boolean')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- Multiplier applied to the raw IO value (fuel counters report millilitres,
  -- so scale 0.001 yields litres).
  scale_factor DOUBLE PRECISION NOT NULL DEFAULT 1,
  UNIQUE (io_id, feature_key)
);

-- scale_factor was added after the first release of this table.
ALTER TABLE io_feature_map ADD COLUMN IF NOT EXISTS scale_factor DOUBLE PRECISION NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS param_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key TEXT NOT NULL,
  param_id INTEGER NOT NULL,
  description TEXT,
  UNIQUE (feature_key, param_id)
);

-- ------------------------------------------------------------------ --
-- Alert type/source columns + the telemetry exception category
-- ------------------------------------------------------------------ --
ALTER TABLE alerts           ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE alerts           ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE fleet_exceptions ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE fleet_exceptions ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE fleet_exceptions DROP CONSTRAINT IF EXISTS fleet_exceptions_category_check;
ALTER TABLE fleet_exceptions ADD CONSTRAINT fleet_exceptions_category_check
  CHECK (category IN ('fuel', 'gps', 'driver', 'vehicle', 'maintenance', 'route', 'security', 'compliance', 'geofence', 'telemetry'));

-- ------------------------------------------------------------------ --
-- Indexes
-- ------------------------------------------------------------------ --
CREATE INDEX IF NOT EXISTS idx_vehicles_client ON vehicles(client_id);
CREATE INDEX IF NOT EXISTS idx_gps_devices_client ON gps_devices(client_id);
CREATE INDEX IF NOT EXISTS idx_user_clients_user ON user_clients(user_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_records_vehicle ON telemetry_records(vehicle_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_records_imei ON telemetry_records(imei, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_imei ON device_commands(imei, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_status ON device_commands(status);

-- ------------------------------------------------------------------ --
-- Default IO feature map (Teltonika FMB125 AVL element ids). Starting
-- defaults only — adjust to match the device's configured IO list.
-- The GNSS fuel counters (IO 12/13) report millilitres, hence scale_factor
-- 0.001 so the ingest fallback stores litres in fuel_liters.
-- ------------------------------------------------------------------ --
INSERT INTO io_feature_map (io_id, feature_key, label, value_type, scale_factor) VALUES
  (12,  'fuel_counter',      'GNSS Fuel Counter (primary)',        'scalar',  0.001),
  (13,  'fuel_counter',      'GNSS Fuel Counter (secondary)',      'scalar',  0.001),
  (255, 'overspeed',         'Overspeeding',                       'event',   1),
  (253, 'eco_accel',         'Eco Driving — Harsh Acceleration',   'event',   1),
  (254, 'eco_brake',         'Eco Driving — Harsh Braking',        'event',   1),
  (251, 'idling',            'Excessive Idling',                   'event',   1),
  (252, 'power_unplug',      'Power Unplug / Tamper',              'event',   1),
  (246, 'towing',            'Towing Detected',                    'event',   1),
  (247, 'crash',             'Crash Detection',                    'event',   1),
  (175, 'geofence_auto',     'Auto / Manual Geofence',             'event',   1),
  (174, 'geofence_zone',     'Geofence Zone Event (IO 155-174)',   'event',   1),
  (179, 'immobilizer',       'DOUT1 / Immobilizer',                'boolean', 1),
  (179, 'dout_ignition',     'DOUT Driven by Ignition',            'boolean', 1),
  (249, 'jamming',           'Network Jamming',                    'event',   1),
  (78,  'ibutton',           'iButton / Driver ID Read',           'scalar',  1)
ON CONFLICT (io_id, feature_key) DO UPDATE SET scale_factor = EXCLUDED.scale_factor;

-- ------------------------------------------------------------------ --
-- Default Teltonika parameter map (parameter ids are device-configurable;
-- confirm against the FMB125 parameter list before relying on them).
-- ------------------------------------------------------------------ --
INSERT INTO param_map (feature_key, param_id, description) VALUES
  ('overspeed_threshold',   1580, 'Overspeeding threshold (km/h)'),
  ('idling_timeout',        1581, 'Excessive idling timeout (seconds)'),
  ('eco_driving_threshold', 1582, 'Eco (green) driving sensitivity'),
  ('geofence_radius',       2051, 'Auto geofence radius (metres)'),
  ('immobilizer_dout',      1028, 'DOUT1 / immobiliser control')
ON CONFLICT (feature_key, param_id) DO NOTHING;

-- ------------------------------------------------------------------ --
-- Seed the two Teltonika FMB125 trackers (mirrors apps/api/src/seed/seed.ts).
-- Registered by IMEI as device_identifier, bound to V-101 / V-102, and the
-- vehicle's gps_device_id is pointed at the tracker. gps_devices.device_identifier
-- is UNIQUE, so re-running this block is a no-op.
-- ------------------------------------------------------------------ --
INSERT INTO gps_devices (vehicle_id, device_identifier, device_type, client_id, status)
SELECT v.id, '354018115690145', 'teltonika', v.client_id, 'active'
FROM vehicles v
WHERE v.vehicle_number = 'V-101'
ON CONFLICT (device_identifier) DO NOTHING;

INSERT INTO gps_devices (vehicle_id, device_identifier, device_type, client_id, status)
SELECT v.id, '354018115694907', 'teltonika', v.client_id, 'active'
FROM vehicles v
WHERE v.vehicle_number = 'V-102'
ON CONFLICT (device_identifier) DO NOTHING;

UPDATE vehicles v
SET gps_device_id = d.id
FROM gps_devices d
WHERE d.device_type = 'teltonika'
  AND d.vehicle_id = v.id
  AND d.device_identifier IN ('354018115690145', '354018115694907');
