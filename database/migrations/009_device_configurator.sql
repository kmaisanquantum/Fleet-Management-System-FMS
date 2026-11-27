-- Fleet Management System — Migration 009
-- Teltonika Configurator workspace: tracker identity replies and registry state.
--
-- Desired/applied parameters and command history already live in
-- device_config_state and device_commands (migration 008). This migration adds
-- the latest `getinfo` / `getver` / `getstatus` / `getio` replies so the
-- configurator header can show firmware and device identity without replaying
-- the command log.

ALTER TABLE gps_devices ADD COLUMN IF NOT EXISTS firmware_version TEXT;
ALTER TABLE gps_devices ADD COLUMN IF NOT EXISTS device_info_json JSONB;
ALTER TABLE gps_devices ADD COLUMN IF NOT EXISTS device_info_updated_at TIMESTAMPTZ;

-- Optional profile snapshots saved from the Configurator "Save to file" action.
-- File import/export remains client-side; this table lets an operator retain a
-- server-side copy for cloning a configuration across IMEIs.
CREATE TABLE IF NOT EXISTS device_config_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  device_model TEXT NOT NULL DEFAULT 'FMB125',
  imei TEXT,
  values_json JSONB NOT NULL,
  metadata_json JSONB,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_config_profiles_model
  ON device_config_profiles(device_model, created_at DESC);

-- Seed the registry parameter IDs used by the Configurator into param_map so
-- raw feature-key lookups keep working alongside the registry. Parameter IDs
-- and ranges follow the FMB125 parameter list (firmware 03.25.x).
INSERT INTO param_map (feature_key, param_id, description) VALUES
  ('overspeeding_scenario',              11100, 'Overspeeding scenario priority'),
  ('overspeeding_max_speed',             11104, 'Overspeeding max speed (km/h)'),
  ('overspeeding_output',                11103, 'Overspeeding output control'),
  ('overspeeding_dout_on',               11101, 'Overspeeding DOUT ON duration (ms)'),
  ('overspeeding_dout_off',              11102, 'Overspeeding DOUT OFF duration (ms)'),
  ('immobilizer_scenario',               11700, 'Immobilizer scenario priority'),
  ('immobilizer_eventual_records',       11701, 'Immobilizer eventual records'),
  ('immobilizer_output',                 11702, 'Immobilizer output control'),
  ('immobilizer_auth_check',             11703, 'Immobilizer authorization list check'),
  ('immobilizer_ignition_off_timeout',   60068, 'Immobilizer ignition OFF timeout (s)'),
  ('jamming_scenario',                   11300, 'Network jamming scenario priority'),
  ('jamming_eventual_records',           11303, 'Network jamming eventual records'),
  ('jamming_output',                     11304, 'Network jamming output control'),
  ('jamming_dout_on',                    11301, 'Network jamming DOUT ON duration (ms)'),
  ('jamming_dout_off',                   11302, 'Network jamming DOUT OFF duration (ms)'),
  ('jamming_detection_timeout',          11305, 'Network jamming detection timeout (s)'),
  ('gnss_fuel_city_consumption',         11900, 'GNSS fuel city consumption (L/100km)'),
  ('gnss_fuel_highway_consumption',      11901, 'GNSS fuel highway consumption (L/100km)'),
  ('gnss_fuel_average_consumption',      11902, 'GNSS fuel average consumption (L/100km)'),
  ('gnss_fuel_city_speed',               11903, 'GNSS fuel city speed (km/h)'),
  ('gnss_fuel_highway_speed',            11904, 'GNSS fuel highway speed (km/h)'),
  ('gnss_fuel_average_speed',            11905, 'GNSS fuel average speed (km/h)'),
  ('gnss_fuel_correction',               11906, 'GNSS fuel correction coefficient'),
  ('gnss_fuel_idling',                   11907, 'GNSS fuel consumption on idling (L/h)'),
  ('gnss_fuel_high_speed_add',           11908, 'GNSS fuel higher speeds add (%)'),
  ('gnss_fuel_highway_every',            11909, 'GNSS fuel highway consumption every (km/h)')
ON CONFLICT (feature_key, param_id) DO NOTHING;
