-- Fleet Management System — Production Schema (PostgreSQL)
-- Migration 001: initial schema
--
-- This is the production-target schema referenced in DATABASE.md. The MVP's
-- runnable demo uses an equivalent SQLite schema (apps/api/src/db/schema.sql)
-- so the prototype has zero external infrastructure dependencies; this file
-- is the source of truth for deploying against real PostgreSQL.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =========================================================================
-- RBAC
-- =========================================================================
CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE business_rules (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('number', 'string', 'boolean')),
  label TEXT,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id)
);

-- =========================================================================
-- Master data: airports (not hard-coded), facilities, products
-- =========================================================================
CREATE TABLE airports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  iata_code TEXT,
  name TEXT NOT NULL,
  region TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  connectivity_profile TEXT NOT NULL DEFAULT 'online' CHECK (connectivity_profile IN ('online','intermittent','offline_capable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_by UUID
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id),
  airport_id UUID REFERENCES airports(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_by UUID
);
ALTER TABLE airports ADD CONSTRAINT fk_airports_created_by FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE airports ADD CONSTRAINT fk_airports_updated_by FOREIGN KEY (updated_by) REFERENCES users(id);

CREATE TABLE fuel_facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  name TEXT NOT NULL,
  facility_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (airport_id, facility_code)
);

CREATE TABLE fuel_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  fuel_type TEXT NOT NULL,
  unit_of_measure TEXT NOT NULL DEFAULT 'L',
  density NUMERIC(6,4),
  minimum_stock NUMERIC(14,2) NOT NULL DEFAULT 0,
  maximum_stock NUMERIC(14,2) NOT NULL DEFAULT 0,
  safety_stock NUMERIC(14,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_name TEXT, contact_email TEXT, contact_phone TEXT,
  contract_ref TEXT, contract_start DATE, contract_expiry DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  customer_type TEXT NOT NULL DEFAULT 'airline',
  billing_email TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE airlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  name TEXT NOT NULL,
  iata_code TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE aircraft (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airline_id UUID REFERENCES airlines(id),
  registration TEXT UNIQUE NOT NULL,
  aircraft_type TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- Physical assets
-- =========================================================================
CREATE TABLE tanks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  fuel_facility_id UUID NOT NULL REFERENCES fuel_facilities(id),
  fuel_product_id UUID NOT NULL REFERENCES fuel_products(id),
  tank_code TEXT NOT NULL,
  capacity NUMERIC(14,2) NOT NULL CHECK (capacity > 0),
  current_level NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (current_level >= 0),
  temperature NUMERIC(5,2),
  water_level NUMERIC(5,2),
  status TEXT NOT NULL DEFAULT 'active',
  installation_date DATE,
  last_inspection DATE, next_inspection DATE,
  calibration_date DATE, next_calibration DATE,
  maintenance_status TEXT NOT NULL DEFAULT 'ok',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (airport_id, tank_code),
  CHECK (current_level <= capacity)
);

CREATE TABLE refuellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  asset_code TEXT UNIQUE NOT NULL,
  registration TEXT,
  capacity NUMERIC(12,2) NOT NULL CHECK (capacity > 0),
  fuel_product_id UUID REFERENCES fuel_products(id),
  current_level NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','offline','decommissioned')),
  last_maintenance DATE, next_maintenance DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refueller_id UUID REFERENCES refuellers(id),
  meter_code TEXT NOT NULL,
  last_calibration DATE, next_calibration DATE,
  status TEXT NOT NULL DEFAULT 'active'
);

-- =========================================================================
-- Fuel movement workflow tables
-- =========================================================================
CREATE TABLE fuel_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT UNIQUE NOT NULL,
  airport_id UUID NOT NULL REFERENCES airports(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  tank_id UUID NOT NULL REFERENCES tanks(id),
  fuel_product_id UUID NOT NULL REFERENCES fuel_products(id),
  quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  delivery_vehicle TEXT, driver_name TEXT, delivery_document TEXT, batch_number TEXT,
  meter_reading NUMERIC(14,2), quality_cert_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','verified','approved','posted')),
  receiving_officer_id UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id), approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id), updated_by UUID REFERENCES users(id)
);

CREATE TABLE fuel_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT UNIQUE NOT NULL,
  airport_id UUID NOT NULL REFERENCES airports(id),
  destination_airport_id UUID REFERENCES airports(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('tank','refueller')),
  source_id UUID NOT NULL,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('tank','refueller')),
  destination_id UUID NOT NULL,
  fuel_product_id UUID NOT NULL REFERENCES fuel_products(id),
  quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  source_meter_reading NUMERIC(14,2), destination_meter_reading NUMERIC(14,2),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  operator_id UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id), approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

CREATE TABLE fuel_uplifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT UNIQUE NOT NULL,
  airport_id UUID NOT NULL REFERENCES airports(id),
  airline_id UUID NOT NULL REFERENCES airlines(id),
  aircraft_id UUID NOT NULL REFERENCES aircraft(id),
  flight_number TEXT,
  fuel_product_id UUID NOT NULL REFERENCES fuel_products(id),
  refueller_id UUID NOT NULL REFERENCES refuellers(id),
  tank_id UUID NOT NULL REFERENCES tanks(id),
  quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  start_meter_reading NUMERIC(14,2), end_meter_reading NUMERIC(14,2),
  price_per_litre NUMERIC(10,4) NOT NULL,
  total_amount NUMERIC(14,2) NOT NULL,
  operator_id UUID REFERENCES users(id),
  customer_authorisation TEXT,
  invoice_status TEXT NOT NULL DEFAULT 'not_invoiced',
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

-- =========================================================================
-- Immutable inventory ledger — the system of record for stock
-- =========================================================================
CREATE TABLE inventory_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  tank_id UUID NOT NULL REFERENCES tanks(id),
  fuel_product_id UUID NOT NULL REFERENCES fuel_products(id),
  txn_type TEXT NOT NULL CHECK (txn_type IN
    ('RECEIPT','TRANSFER_IN','TRANSFER_OUT','AIRCRAFT_UPLIFT','RETURN','ADJUSTMENT','LOSS','CORRECTION')),
  quantity NUMERIC(14,2) NOT NULL, -- signed: positive inbound, negative outbound
  reference_type TEXT NOT NULL,
  reference_id UUID,
  balance_after NUMERIC(14,2) NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id)
);
-- Immutability: revoke UPDATE/DELETE grants on this table for application roles in production;
-- corrections must be posted as new CORRECTION rows, never edits to history.

CREATE TABLE inventory_balances (
  tank_id UUID PRIMARY KEY REFERENCES tanks(id),
  airport_id UUID NOT NULL REFERENCES airports(id),
  fuel_product_id UUID NOT NULL REFERENCES fuel_products(id),
  current_level NUMERIC(14,2) NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  tank_id UUID NOT NULL REFERENCES tanks(id),
  recon_date DATE NOT NULL,
  opening_stock NUMERIC(14,2) NOT NULL,
  receipts NUMERIC(14,2) NOT NULL DEFAULT 0,
  transfers_in NUMERIC(14,2) NOT NULL DEFAULT 0,
  transfers_out NUMERIC(14,2) NOT NULL DEFAULT 0,
  aircraft_uplift NUMERIC(14,2) NOT NULL DEFAULT 0,
  adjustments NUMERIC(14,2) NOT NULL DEFAULT 0,
  expected_closing NUMERIC(14,2) NOT NULL,
  actual_closing NUMERIC(14,2),
  variance NUMERIC(14,2),
  variance_pct NUMERIC(6,3),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reconciled','investigation_required','approved')),
  explanation TEXT,
  approved_by UUID REFERENCES users(id), approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tank_id, recon_date)
);

-- =========================================================================
-- Quality, maintenance, inspections
-- =========================================================================
CREATE TABLE fuel_quality_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_ref TEXT UNIQUE NOT NULL,
  airport_id UUID NOT NULL REFERENCES airports(id),
  tank_id UUID REFERENCES tanks(id),
  fuel_product_id UUID NOT NULL REFERENCES fuel_products(id),
  sample_date DATE NOT NULL,
  sample_type TEXT, test_type TEXT, result TEXT,
  pass_fail TEXT NOT NULL DEFAULT 'pending' CHECK (pass_fail IN ('pass','fail','pending')),
  technician TEXT, certificate_ref TEXT, comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('tank','refueller','meter','other')),
  asset_id UUID NOT NULL,
  maintenance_type TEXT, scheduled_date DATE, completed_date DATE,
  technician TEXT, work_performed TEXT, parts TEXT, cost NUMERIC(12,2),
  next_maintenance DATE,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  asset_type TEXT NOT NULL, asset_id UUID NOT NULL,
  inspection_date DATE NOT NULL, inspector TEXT, result TEXT, notes TEXT,
  next_inspection DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- Billing
-- =========================================================================
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT UNIQUE NOT NULL,
  airport_id UUID NOT NULL REFERENCES airports(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  uplift_id UUID REFERENCES fuel_uplifts(id),
  amount NUMERIC(14,2) NOT NULL,
  taxes_fees NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PGK',
  invoice_date DATE NOT NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','overdue','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  amount NUMERIC(14,2) NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  method TEXT, reference TEXT
);

-- =========================================================================
-- Alerts & audit
-- =========================================================================
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity TEXT NOT NULL CHECK (severity IN ('critical','warning')),
  airport_id UUID REFERENCES airports(id),
  asset_type TEXT, asset_id UUID,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  assigned_to UUID REFERENCES users(id),
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  role TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  previous_value JSONB,
  new_value JSONB,
  ip_address INET,
  device TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Immutability: revoke UPDATE/DELETE on audit_logs for all application roles.

-- =========================================================================
-- IoT & offline sync
-- =========================================================================
CREATE TABLE iot_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('tank','refueller')),
  asset_id UUID NOT NULL,
  device_type TEXT NOT NULL CHECK (device_type IN ('level_sensor','flow_meter','temperature','water_detection','gps')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iot_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES iot_devices(id),
  reading_type TEXT NOT NULL,
  value NUMERIC(14,4) NOT NULL,
  unit TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Recommended: convert to a TimescaleDB hypertable in production for high-volume telemetry.

CREATE TABLE sync_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id),
  entity TEXT NOT NULL,
  local_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','synced','conflict')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ
);

-- =========================================================================
-- Indexes
-- =========================================================================
CREATE INDEX idx_inv_txn_tank ON inventory_transactions(tank_id, created_at);
CREATE INDEX idx_inv_txn_airport ON inventory_transactions(airport_id, created_at);
CREATE INDEX idx_uplift_airport ON fuel_uplifts(airport_id, created_at);
CREATE INDEX idx_receipt_airport ON fuel_receipts(airport_id, status);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_alerts_status ON alerts(status, severity);
CREATE INDEX idx_iot_readings_device ON iot_readings(device_id, recorded_at DESC);
CREATE INDEX idx_sync_queue_status ON sync_queue(airport_id, status);
