-- Fleet Management System — Production Schema (PostgreSQL)
-- Migration 005: rich telemetry records, device commands, and configurable
-- IO/parameter maps for the Teltonika FMB125 fleet.
--
-- Idempotent: safe to re-run. The tenant primitives (clients, user_clients,
-- client_id) are (re)asserted here so this file is also self-contained on a
-- database that predates them (migration 004).

-- ------------------------------------------------------------------ --
-- Tenant boundary (asserted for self-containment)
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vehicles    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);
ALTER TABLE gps_devices ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);
ALTER TABLE users       ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);

CREATE TABLE IF NOT EXISTS user_clients (
  user_id UUID NOT NULL REFERENCES users(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id)
);

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

CREATE INDEX IF NOT EXISTS idx_telemetry_records_vehicle ON telemetry_records(vehicle_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_records_imei ON telemetry_records(imei, recorded_at DESC);

-- ------------------------------------------------------------------ --
-- Outbound device commands (Codec 12) queued for the tracker's next TCP
-- session via the meshsat.dspng.space VPS command endpoint (POST /api/cmd).
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

CREATE INDEX IF NOT EXISTS idx_device_commands_imei ON device_commands(imei, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_status ON device_commands(status);

-- ------------------------------------------------------------------ --
-- Configurable IO-ID -> feature mapping. Editing this table lets an FMB125
-- Configurator IO change take effect without a code change.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS io_feature_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  io_id INTEGER NOT NULL,
  feature_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'event' CHECK (value_type IN ('event', 'scalar', 'boolean')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (io_id, feature_key)
);

-- ------------------------------------------------------------------ --
-- Configurable Teltonika parameter-ID map used to build setparam commands.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS param_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key TEXT NOT NULL,
  param_id INTEGER NOT NULL,
  description TEXT,
  UNIQUE (feature_key, param_id)
);

-- ------------------------------------------------------------------ --
-- Alert type/source columns (telemetry events).
-- ------------------------------------------------------------------ --
ALTER TABLE alerts           ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE alerts           ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE fleet_exceptions ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE fleet_exceptions ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE fleet_exceptions DROP CONSTRAINT IF EXISTS fleet_exceptions_category_check;
ALTER TABLE fleet_exceptions ADD CONSTRAINT fleet_exceptions_category_check
  CHECK (category IN ('fuel', 'gps', 'driver', 'vehicle', 'maintenance', 'route', 'security', 'compliance', 'geofence', 'telemetry'));

-- ------------------------------------------------------------------ --
-- Default IO feature map (Teltonika FMB125 AVL element ids). These are
-- starting defaults only — adjust to match the device's configured IO list.
-- ------------------------------------------------------------------ --
INSERT INTO io_feature_map (id, io_id, feature_key, label, value_type) VALUES
  ('iof-fuel-counter-12', 12,  'fuel_counter_12',   'GNSS Fuel Counter (primary)',        'scalar'),
  ('iof-fuel-counter-13', 13,  'fuel_counter_13',   'GNSS Fuel Counter (secondary)',      'scalar'),
  ('iof-overspeed',       255, 'overspeed',         'Overspeeding',                       'event'),
  ('iof-eco-accel',       253, 'eco_accel',         'Eco Driving — Harsh Acceleration',   'event'),
  ('iof-eco-brake',       254, 'eco_brake',         'Eco Driving — Harsh Braking',        'event'),
  ('iof-idling',          251, 'idling',            'Excessive Idling',                   'event'),
  ('iof-unplug',          252, 'power_unplug',      'Power Unplug / Tamper',              'event'),
  ('iof-towing',          246, 'towing',            'Towing Detected',                    'event'),
  ('iof-crash',           247, 'crash',             'Crash Detection',                    'event'),
  ('iof-geofence-auto',   175, 'geofence_auto',     'Auto / Manual Geofence',             'event'),
  ('iof-geofence-zone',   174, 'geofence_zone',     'Geofence Zone Event (IO 155-174)',   'event'),
  ('iof-immobilizer',     179, 'immobilizer',       'DOUT1 / Immobilizer',                'boolean'),
  ('iof-dout-ignition',   179, 'dout_ignition',     'DOUT Driven by Ignition',            'boolean'),
  ('iof-jamming',         249, 'jamming',           'Network Jamming',                    'event'),
  ('iof-ibutton',         78,  'ibutton',           'iButton / Driver ID Read',           'scalar')
ON CONFLICT (io_id, feature_key) DO NOTHING;

-- ------------------------------------------------------------------ --
-- Default Teltonika parameter map. Parameter ids are device-configurable;
-- confirm against the FMB125 parameter list before relying on them.
-- ------------------------------------------------------------------ --
INSERT INTO param_map (id, feature_key, param_id, description) VALUES
  ('pm-overspeed-threshold', 'overspeed_threshold',   1580, 'Overspeeding threshold (km/h)'),
  ('pm-idling-timeout',      'idling_timeout',        1581, 'Excessive idling timeout (seconds)'),
  ('pm-eco-driving',         'eco_driving_threshold', 1582, 'Eco (green) driving sensitivity'),
  ('pm-geofence-radius',     'geofence_radius',       2051, 'Auto geofence radius (metres)'),
  ('pm-immobilizer-dout',    'immobilizer_dout',      1028, 'DOUT1 / immobiliser control')
ON CONFLICT (feature_key, param_id) DO NOTHING;
