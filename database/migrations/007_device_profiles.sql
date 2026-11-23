-- Fleet Management System — Production Schema (PostgreSQL)
-- Migration 007: Device profiles, capabilities, media and per-model IO mappings.
--
-- Idempotent data + DDL migration for databases created before this release:
--
--   * gps_devices gains `device_model` (default 'FMB125') and `capabilities`
--     (JSON string of {has_fuel_rs232, has_can_j1939, has_ble_sensors,
--     has_camera, dout_count}) plus `last_seen_at` for a per-device offline
--     watchdog. Existing rows are backfilled to FMB125 with dout_count = 2.
--   * New `device_media` table (+ device_id / captured_at indexes) holding
--     camera/sensor captures reported via POST /api/telemetry/media.
--   * `io_feature_map` gains `device_model` (NULL = all models) and `unit`
--     (engineering-unit label); `param_map` gains the same two columns.
--     The FMB125 normalizations (IO 16 odometer km, IO 66/67 volts) get units.
--   * `device_commands.command_type` CHECK gains 'camreq' (camera request).
--
-- Complementary to schema.sql (which carries the same DDL for fresh installs);
-- every statement is ADD COLUMN IF NOT EXISTS / ON CONFLICT so re-running is a
-- no-op both on fresh and pre-existing databases.

-- ------------------------------------------------------------------ --
-- gps_devices — hardware profile + per-device offline watchdog
-- ------------------------------------------------------------------ --
ALTER TABLE gps_devices
  ADD COLUMN IF NOT EXISTS device_model TEXT DEFAULT 'FMB125',
  ADD COLUMN IF NOT EXISTS capabilities TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Backfill pre-existing devices to the FMB125 profile (2 digital outputs).
UPDATE gps_devices
  SET device_model = 'FMB125'
  WHERE device_model IS NULL OR device_model = '';

UPDATE gps_devices
  SET capabilities = '{"has_fuel_rs232":true,"has_can_j1939":false,"has_ble_sensors":false,"has_camera":false,"dout_count":2}'
  WHERE capabilities IS NULL OR capabilities = '';

-- ------------------------------------------------------------------ --
-- device_media — camera / sensor captures reported by the relay
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS device_media (
  id TEXT PRIMARY KEY,
  device_id TEXT REFERENCES gps_devices(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  client_id TEXT REFERENCES clients(id),
  trigger_type TEXT NOT NULL,
  camera_channel INTEGER,
  media_type TEXT NOT NULL,
  storage_url TEXT NOT NULL,
  captured_at TIMESTAMPTZ,
  metadata_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_media_device ON device_media(device_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_media_captured ON device_media(captured_at DESC);

-- ------------------------------------------------------------------ --
-- io_feature_map / param_map — per-model mapping + engineering unit
--   NULL device_model = applies to every model.
-- ------------------------------------------------------------------ --
ALTER TABLE io_feature_map
  ADD COLUMN IF NOT EXISTS device_model TEXT,
  ADD COLUMN IF NOT EXISTS unit TEXT;

ALTER TABLE param_map
  ADD COLUMN IF NOT EXISTS device_model TEXT,
  ADD COLUMN IF NOT EXISTS unit TEXT;

-- Unit metadata for the FMB125 normalizations (raw IO is scaled by
-- scale_factor; `unit` labels the scaled value).
UPDATE io_feature_map SET unit = 'km' WHERE io_id = 16  AND (unit IS NULL OR unit = '');
UPDATE io_feature_map SET unit = 'V'  WHERE io_id IN (66, 67) AND (unit IS NULL OR unit = '');
UPDATE io_feature_map SET unit = 'L'  WHERE io_id IN (12, 13) AND (unit IS NULL OR unit = '');

-- ------------------------------------------------------------------ --
-- device_commands — 'camreq' (camera request) command type
-- ------------------------------------------------------------------ --
ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_command_type_check;
ALTER TABLE device_commands ADD CONSTRAINT device_commands_command_type_check
  CHECK (command_type IN ('setparam', 'setdigout', 'diagnostic', 'raw', 'camreq'));
