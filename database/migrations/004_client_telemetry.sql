-- Fleet Management System — Production Schema (PostgreSQL)
-- Migration 004: Client (tenant) scoping + rich Teltonika telemetry ingest

-- Tenant boundary for fleet & telemetry data. This is deliberately separate
-- from `airports` (which scopes the fuel-management domain): a fleet client
-- (e.g. a contracted logistics customer) owns a subset of vehicles and the
-- telemetry devices bound to them, and client-role users only see their own.
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users       ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);
ALTER TABLE vehicles    ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);
ALTER TABLE gps_devices ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id);

-- Rich telemetry fields captured from Teltonika FMB125 ingest
ALTER TABLE gps_positions
  ADD COLUMN IF NOT EXISTS imei TEXT,
  ADD COLUMN IF NOT EXISTS sats INTEGER,
  ADD COLUMN IF NOT EXISTS fuel_liters NUMERIC(10,2);

-- Idempotent ingest: at most one position per device per timestamp
CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_positions_imei_time
  ON gps_positions(imei, recorded_at) WHERE imei IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vehicles_client ON vehicles(client_id);
CREATE INDEX IF NOT EXISTS idx_gps_devices_client ON gps_devices(client_id);
CREATE INDEX IF NOT EXISTS idx_gps_positions_imei ON gps_positions(imei, recorded_at DESC);

-- Allow the telemetry-derived fleet-exception category
ALTER TABLE fleet_exceptions DROP CONSTRAINT IF EXISTS fleet_exceptions_category_check;
ALTER TABLE fleet_exceptions ADD CONSTRAINT fleet_exceptions_category_check
  CHECK (category IN ('fuel', 'gps', 'driver', 'vehicle', 'maintenance', 'route', 'security', 'compliance', 'geofence', 'telemetry'));
