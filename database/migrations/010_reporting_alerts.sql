-- Fleet Management System — Migration 010
-- Fleet reporting, real-time alerts, SMTP delivery audit and scheduled reports.

CREATE TABLE IF NOT EXISTS client_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  module TEXT NOT NULL CHECK (module IN ('tracking', 'fuel_immobilizer', 'camera_adas', 'maintenance_dispatch')),
  vehicle_quota INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, module)
);

CREATE INDEX IF NOT EXISTS idx_client_subscriptions_client
  ON client_subscriptions(client_id);

CREATE TABLE IF NOT EXISTS fleet_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imei TEXT NOT NULL,
  vehicle_id UUID REFERENCES vehicles(id),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  message TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  voltage DOUBLE PRECISION,
  email_sent BOOLEAN NOT NULL DEFAULT FALSE,
  email_sent_at TIMESTAMPTZ,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_code TEXT,
  dedupe_key TEXT,
  email_error TEXT,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fleet_alerts_imei_type
  ON fleet_alerts(imei, alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_alerts_vehicle
  ON fleet_alerts(vehicle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_alerts_created
  ON fleet_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_alerts_email
  ON fleet_alerts(email_sent, created_at DESC);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('alert', 'report', 'test', 'scheduled_report')),
  recipient TEXT NOT NULL,
  cc TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  message_id TEXT,
  error TEXT,
  related_alert_id UUID REFERENCES fleet_alerts(id),
  report_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_created
  ON email_deliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_kind
  ON email_deliveries(kind, report_type, created_at DESC);

INSERT INTO business_rules (key, value, value_type, label, description) VALUES
  ('alert_recipient_email',       'fleet@dspng.tech', 'string',  'Alert recipient email',            'Primary recipient for real-time fleet alert emails.'),
  ('alert_cc_emails',             '',                 'string',  'Alert CC recipients',              'Optional comma-separated CC/extra recipients for alert emails.'),
  ('report_recipient_email',      'fleet@dspng.tech', 'string',  'Report recipient email',           'Primary recipient for ad-hoc and scheduled report emails.'),
  ('report_cc_emails',            '',                 'string',  'Report CC recipients',             'Optional comma-separated CC/extra recipients for report emails.'),
  ('alert_email_enabled',         'true',             'boolean', 'Email alerts enabled',             'Send an SMTP email for each newly triggered real-time alert.'),
  ('alert_overspeed_enabled',     'true',             'boolean', 'Overspeeding alerts',              'Raise an alert when speed exceeds alert_overspeed_kmh.'),
  ('alert_ignition_enabled',      'true',             'boolean', 'Ignition alerts',                  'Notify when the ignition transitions ON or OFF.'),
  ('alert_offline_enabled',       'true',             'boolean', 'Device offline alerts',            'Notify when a device has not reported within alert_offline_minutes.'),
  ('alert_power_enabled',         'true',             'boolean', 'Power / voltage alerts',           'Notify on power cut or low external voltage.'),
  ('alert_geofence_enabled',      'true',             'boolean', 'Geofence alerts',                  'Notify on geofence entry and exit events.'),
  ('alert_security_enabled',      'true',             'boolean', 'Security / SOS / DIN alerts',      'Notify on jamming, immobilizer, SOS and digital-input triggers.'),
  ('alert_overspeed_kmh',         '80',               'number',  'Overspeeding threshold (km/h)',    'Speed above this value raises an overspeeding alert.'),
  ('alert_low_voltage_v',         '11.5',             'number',  'Low external voltage (V)',         'External voltage below this value raises a low-voltage alert.'),
  ('alert_cooldown_seconds',      '300',              'number',  'Alert cooldown (seconds)',         'Suppress duplicate alerts of the same type for this many seconds.'),
  ('alert_offline_minutes',       '15',               'number',  'Offline threshold (minutes)',      'A device with no ingest for this many minutes is considered offline.'),
  ('alert_offline_cooldown_minutes', '360',           'number',  'Offline alert cooldown (minutes)', 'Suppress repeated offline alerts for the same device for this many minutes.'),
  ('alert_idle_minutes',          '10',               'number',  'Excessive idling threshold (min)','Idle duration used by the idling exception report.'),
  ('report_daily_enabled',        'true',             'boolean', 'Daily report enabled',             'Email a daily fleet summary at the configured Port Moresby time.'),
  ('report_weekly_enabled',       'true',             'boolean', 'Weekly report enabled',            'Email a weekly fleet summary every Monday.'),
  ('report_monthly_enabled',      'true',             'boolean', 'Monthly report enabled',           'Email a monthly fleet summary on the first day of each month.'),
  ('report_daily_time_pgt',       '07:00',            'string',  'Daily report time (PGT)',          'Port Moresby local time (UTC+10) for the daily report.'),
  ('report_weekly_time_pgt',      '07:00',            'string',  'Weekly report time (PGT)',         'Port Moresby local time (UTC+10) for the Monday report.'),
  ('report_monthly_time_pgt',     '07:00',            'string',  'Monthly report time (PGT)',        'Port Moresby local time (UTC+10) for the monthly report.')
ON CONFLICT (key) DO NOTHING;
