-- Fleet Management System — Production Schema (PostgreSQL)
-- Migration 003: Teltonika FMB125 telemetry integration

-- Teltonika AVL telemetry fields on GPS positions
ALTER TABLE gps_positions
  ADD COLUMN IF NOT EXISTS ignition_source TEXT,
  ADD COLUMN IF NOT EXISTS movement_source TEXT,
  ADD COLUMN IF NOT EXISTS gsm_signal INTEGER,
  ADD COLUMN IF NOT EXISTS external_voltage_mv INTEGER,
  ADD COLUMN IF NOT EXISTS geofence_zone_id TEXT,
  ADD COLUMN IF NOT EXISTS trip_odometer NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS fuel_level_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS engine_rpm INTEGER,
  ADD COLUMN IF NOT EXISTS engine_hours NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS harsh_event TEXT CHECK (harsh_event IN ('harsh_acceleration', 'harsh_braking', 'harsh_cornering', 'crash')),
  ADD COLUMN IF NOT EXISTS driver_id_tag TEXT,
  ADD COLUMN IF NOT EXISTS io_json JSONB;

-- Vendor / protocol discriminator for registered telemetry devices
ALTER TABLE gps_devices
  ADD COLUMN IF NOT EXISTS device_type TEXT NOT NULL DEFAULT 'meshsat'
    CHECK (device_type IN ('meshsat', 'teltonika'));

-- Vehicle live-state fields fed by telemetry
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS current_fuel_level_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS current_engine_hours NUMERIC(12,2);

-- Extend allowed driver event types (harsh cornering & crash detection)
ALTER TABLE driver_events DROP CONSTRAINT IF EXISTS driver_events_event_type_check;
ALTER TABLE driver_events ADD CONSTRAINT driver_events_event_type_check
  CHECK (event_type IN ('speeding', 'harsh_braking', 'harsh_accel', 'excessive_idling', 'harsh_cornering', 'crash'));

-- Add geofence exception category
ALTER TABLE fleet_exceptions DROP CONSTRAINT IF EXISTS fleet_exceptions_category_check;
ALTER TABLE fleet_exceptions ADD CONSTRAINT fleet_exceptions_category_check
  CHECK (category IN ('fuel', 'gps', 'driver', 'vehicle', 'maintenance', 'route', 'security', 'compliance', 'geofence'));

CREATE INDEX IF NOT EXISTS idx_gps_devices_type ON gps_devices(device_type);
