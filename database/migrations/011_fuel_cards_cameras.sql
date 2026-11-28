-- Fleet Management System — Migration 011
-- Fuel card management/reconciliation and camera feed monitoring.

ALTER TABLE fuel_cards
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS assigned_vehicle_id UUID REFERENCES vehicles(id),
  ADD COLUMN IF NOT EXISTS assigned_imei TEXT,
  ADD COLUMN IF NOT EXISTS assigned_driver_id UUID REFERENCES drivers(id),
  ADD COLUMN IF NOT EXISTS daily_limit_liters NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS monthly_limit_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE fuel_cards
SET assigned_vehicle_id = COALESCE(assigned_vehicle_id, vehicle_id),
    assigned_driver_id = COALESCE(assigned_driver_id, authorised_driver_id);

ALTER TABLE fuel_cards DROP CONSTRAINT IF EXISTS fuel_cards_status_check;
ALTER TABLE fuel_cards
  ADD CONSTRAINT fuel_cards_status_check
  CHECK (status IN ('active', 'suspended', 'blocked', 'cancelled', 'lost'));

CREATE TABLE IF NOT EXISTS fuel_card_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fuel_card_id UUID REFERENCES fuel_cards(id),
  card_number TEXT NOT NULL,
  vehicle_id UUID REFERENCES vehicles(id),
  imei TEXT,
  transaction_at TIMESTAMPTZ NOT NULL,
  station_name TEXT,
  station_lat NUMERIC(9,6),
  station_lon NUMERIC(9,6),
  liters NUMERIC(10,2) NOT NULL,
  amount NUMERIC(12,2),
  currency TEXT NOT NULL DEFAULT 'PGK',
  gps_lat NUMERIC(9,6),
  gps_lon NUMERIC(9,6),
  distance_km NUMERIC(10,3),
  status TEXT NOT NULL DEFAULT 'matched' CHECK (status IN ('matched', 'flagged')),
  flag_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fuel_card_txn_card
  ON fuel_card_transactions(fuel_card_id, transaction_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_card_txn_vehicle
  ON fuel_card_transactions(vehicle_id, transaction_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_card_txn_status
  ON fuel_card_transactions(status, transaction_at DESC);

CREATE TABLE IF NOT EXISTS camera_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'vehicle' CHECK (scope IN ('depot', 'vehicle')),
  depot TEXT,
  vehicle_id UUID REFERENCES vehicles(id),
  imei TEXT,
  stream_url TEXT,
  snapshot_url TEXT,
  mode TEXT NOT NULL DEFAULT 'snapshot' CHECK (mode IN ('snapshot', 'mjpeg', 'hls', 'webrtc')),
  poll_interval_sec INTEGER NOT NULL DEFAULT 60,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  client_id UUID REFERENCES clients(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_camera_feeds_vehicle
  ON camera_feeds(vehicle_id, is_active);
CREATE INDEX IF NOT EXISTS idx_camera_feeds_depot
  ON camera_feeds(depot, is_active);
CREATE INDEX IF NOT EXISTS idx_camera_feeds_client
  ON camera_feeds(client_id, is_active);

INSERT INTO business_rules (key, value, value_type, label, description) VALUES
  ('alert_fuel_card_enabled', 'true', 'boolean', 'Fuel card anomaly alerts', 'Email fleet@dspng.tech when a fuel card transaction fails reconciliation.'),
  ('fuel_card_distance_threshold_km', '2', 'number', 'Fuel card GPS distance threshold (km)', 'Flag a swipe when the vehicle GPS position is farther than this from the station.'),
  ('fuel_card_reconcile_window_minutes', '20', 'number', 'Fuel card GPS match window (minutes)', 'Search for the nearest vehicle GPS fix within this many minutes of the swipe.'),
  ('alert_camera_offline_enabled', 'true', 'boolean', 'Camera offline alerts', 'Email fleet@dspng.tech when a camera feed is unreachable.'),
  ('camera_offline_minutes', '15', 'number', 'Camera offline threshold (minutes)', 'A camera with no successful probe for this long is considered offline.'),
  ('camera_offline_cooldown_minutes', '360', 'number', 'Camera offline repeat (minutes)', 'Suppress repeated camera offline alerts for this many minutes.')
ON CONFLICT (key) DO NOTHING;
