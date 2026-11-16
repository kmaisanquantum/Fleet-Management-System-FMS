-- Driver Portal Schema Addition
-- Adds the `driver` role linkage on users plus the tables backing the
-- Driver Portal module (self-service submissions reviewed by admin).
-- Mirrors the runtime schema in apps/api/src/db/schema.sql.

-- Link a login account to a drivers record
ALTER TABLE users ADD COLUMN driver_id TEXT REFERENCES drivers(id);

-- Extra columns on existing fleet modules used by the portal
ALTER TABLE vehicle_inspections ADD COLUMN driver_id TEXT REFERENCES drivers(id);
ALTER TABLE vehicle_inspections ADD COLUMN photo_urls TEXT;
ALTER TABLE vehicle_inspections ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0;

ALTER TABLE vehicle_maintenance ADD COLUMN driver_id TEXT REFERENCES drivers(id);
ALTER TABLE vehicle_maintenance ADD COLUMN requested_by TEXT REFERENCES users(id);

ALTER TABLE vehicle_fuel_logs ADD COLUMN receipt_url TEXT;

CREATE TABLE IF NOT EXISTS vehicle_faults (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver_id TEXT REFERENCES drivers(id),
  reported_by_user_id TEXT REFERENCES users(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('minor', 'major', 'critical')),
  odometer REAL,
  photo_urls TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'cleared', 'rejected')),
  admin_notes TEXT,
  maintenance_id TEXT REFERENCES vehicle_maintenance(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inspection_items (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES vehicle_inspections(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('satisfactory', 'defective', 'na')),
  is_critical INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incident_reports (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT REFERENCES vehicles(id),
  driver_id TEXT REFERENCES drivers(id),
  reported_by_user_id TEXT REFERENCES users(id),
  incident_type TEXT NOT NULL CHECK(incident_type IN ('accident', 'incident', 'near_miss', 'damage', 'theft', 'other')),
  incident_date TEXT NOT NULL,
  location TEXT,
  description TEXT NOT NULL,
  injuries INTEGER NOT NULL DEFAULT 0,
  injury_details TEXT,
  damage_description TEXT,
  third_party_details TEXT,
  photo_urls TEXT,
  document_urls TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'under_review', 'investigating', 'closed')),
  admin_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_leave_requests (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  user_id TEXT REFERENCES users(id),
  leave_type TEXT NOT NULL CHECK(leave_type IN ('annual', 'sick', 'compassionate', 'unpaid', 'other')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
  admin_notes TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_documents (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  user_id TEXT REFERENCES users(id),
  document_type TEXT NOT NULL,
  title TEXT NOT NULL,
  file_url TEXT,
  file_name TEXT,
  mime_type TEXT,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'rejected', 'expired')),
  admin_notes TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  driver_id TEXT REFERENCES drivers(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  related_entity TEXT,
  related_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_faults_vehicle ON vehicle_faults(vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_faults_driver ON vehicle_faults(driver_id);
CREATE INDEX IF NOT EXISTS idx_incidents_driver ON incident_reports(driver_id);
CREATE INDEX IF NOT EXISTS idx_leave_driver ON driver_leave_requests(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_driver ON driver_documents(driver_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON driver_notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_inspection_items_inspection ON inspection_items(inspection_id);
CREATE INDEX IF NOT EXISTS idx_users_driver ON users(driver_id);
