-- Fleet Management System — Production Schema (PostgreSQL)
-- Migration 002: Fleet Intelligence Extension

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS tank_capacity_litres NUMERIC(10,2) DEFAULT 80.0,
  ADD COLUMN IF NOT EXISTS expected_km_per_l NUMERIC(6,2) DEFAULT 8.0,
  ADD COLUMN IF NOT EXISTS gps_device_id TEXT,
  ADD COLUMN IF NOT EXISTS fuel_card_id TEXT,
  ADD COLUMN IF NOT EXISTS current_odometer NUMERIC(12,2) DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS current_latitude NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS current_longitude NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS current_location_name TEXT,
  ADD COLUMN IF NOT EXISTS last_gps_fix_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS gps_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID REFERENCES vehicles(id),
  device_identifier TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gps_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id),
  lat NUMERIC(9,6) NOT NULL,
  lon NUMERIC(9,6) NOT NULL,
  speed NUMERIC(6,2) NOT NULL DEFAULT 0,
  heading NUMERIC(6,2) NOT NULL DEFAULT 0,
  ignition BOOLEAN NOT NULL DEFAULT false,
  odometer NUMERIC(12,2) NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  geofence_status TEXT NOT NULL DEFAULT 'inside'
);

CREATE TABLE IF NOT EXISTS fuel_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_number TEXT UNIQUE NOT NULL,
  vehicle_id UUID REFERENCES vehicles(id),
  authorised_driver_id UUID REFERENCES drivers(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'blocked', 'cancelled')),
  limits JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fuel_stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  station_type TEXT NOT NULL DEFAULT 'station' CHECK (station_type IN ('station', 'depot')),
  lat NUMERIC(9,6) NOT NULL,
  lon NUMERIC(9,6) NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS geofences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  lat NUMERIC(9,6) NOT NULL,
  lon NUMERIC(9,6) NOT NULL,
  radius_meters NUMERIC(10,2) NOT NULL DEFAULT 1000,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN ('speeding', 'harsh_braking', 'harsh_accel', 'excessive_idling')),
  vehicle_id UUID REFERENCES vehicles(id),
  driver_id UUID REFERENCES drivers(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  value NUMERIC(10,2) NOT NULL DEFAULT 0,
  lat NUMERIC(9,6),
  lon NUMERIC(9,6)
);

ALTER TABLE vehicle_fuel_logs
  ADD COLUMN IF NOT EXISTS fuel_card_id UUID REFERENCES fuel_cards(id),
  ADD COLUMN IF NOT EXISTS station_id UUID REFERENCES fuel_stations(id),
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('card', 'depot', 'manual')),
  ADD COLUMN IF NOT EXISTS gps_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciliation_status TEXT NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN ('verified', 'exception', 'pending'));

CREATE TABLE IF NOT EXISTS fleet_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  category TEXT NOT NULL CHECK (category IN ('fuel', 'gps', 'driver', 'vehicle', 'maintenance', 'route', 'security', 'compliance')),
  rule_code TEXT NOT NULL,
  vehicle_id UUID REFERENCES vehicles(id),
  driver_id UUID REFERENCES drivers(id),
  transaction_id UUID REFERENCES vehicle_fuel_logs(id),
  gps_position_id UUID REFERENCES gps_positions(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  notes TEXT,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE OR REPLACE VIEW vehicle_status_view AS
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
    WHEN v.status IN ('inactive', 'disposed') THEN 'unassigned'
    WHEN gp.recorded_at IS NULL OR gp.recorded_at < (now() - INTERVAL '2 hours') THEN 'offline'
    WHEN gp.ignition IS TRUE AND gp.speed > 5 THEN 'moving'
    WHEN gp.ignition IS TRUE AND gp.speed <= 5 THEN 'idle'
    ELSE 'stationary'
  END AS computed_status
FROM vehicles v
LEFT JOIN (
  SELECT DISTINCT ON (vehicle_id) *
  FROM gps_positions
  ORDER BY vehicle_id, recorded_at DESC
) gp ON v.id = gp.vehicle_id;

CREATE INDEX IF NOT EXISTS idx_gps_positions_vehicle ON gps_positions(vehicle_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_exceptions_status ON fleet_exceptions(status, severity);
