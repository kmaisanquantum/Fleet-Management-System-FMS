-- Fleet Management System — Production Schema (PostgreSQL)
-- Migration 006: Telemetry / command-pipeline safeguards + FMB125 IO normalizations.
--
-- Idempotent data + DDL migration for databases created before this release:
--
--   * device_commands gains `reason` (operator justification) and `acked_at`
--     (tracker Codec 12 reply time), and the status CHECK gains 'acknowledged'
--     (keeping the legacy 'acked' value working).
--   * vehicles gains `last_seen_at` for the offline watchdog.
--   * io_feature_map gains the FMB125 IO normalizations (16 odometer,
--     66 external_voltage, 67 internal_battery, 240 movement).
--
-- Complementary to 003_telemetry.sql (which already carries the same DDL for
-- fresh installs); every statement is ADD COLUMN IF NOT EXISTS / ON CONFLICT so
-- re-running is a no-op both on fresh and pre-existing databases.

-- ------------------------------------------------------------------ --
-- device_commands — reason + acked_at + 'acknowledged' status
-- ------------------------------------------------------------------ --
ALTER TABLE device_commands
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ;

ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_status_check;
ALTER TABLE device_commands ADD CONSTRAINT device_commands_status_check
  CHECK (status IN ('queued', 'sent', 'acked', 'acknowledged', 'failed'));

-- ------------------------------------------------------------------ --
-- vehicles — offline watchdog timestamp
-- ------------------------------------------------------------------ --
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- ------------------------------------------------------------------ --
-- io_feature_map — FMB125 IO normalizations (scaled into engineering units).
--   IO 16  odometer          m  -> km (0.001)
--   IO 66  external_voltage mV -> V  (0.001)
--   IO 67  internal_battery mV -> V  (0.001)
--   IO 240 movement          boolean
-- (IO 239 ignition was seeded by earlier migrations.)
-- ------------------------------------------------------------------ --
INSERT INTO io_feature_map (io_id, feature_key, label, value_type, scale_factor) VALUES
  (16,  'odometer',          'Odometer',          'scalar',  0.001),
  (66,  'external_voltage',  'External Voltage',  'scalar',  0.001),
  (67,  'internal_battery',  'Internal Battery',  'scalar',  0.001),
  (240, 'movement',          'Movement',          'boolean', 1)
ON CONFLICT (io_id, feature_key) DO NOTHING;
