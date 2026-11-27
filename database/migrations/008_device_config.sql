-- Fleet Management System — Migration 008
-- Remote Teltonika FMB125 configuration state.
--
-- Configuration writes are queued in device_commands and delivered through the
-- MeshSat gateway. The tracker's Codec 12 reply arrives on
-- POST /api/telemetry/commands/ack, which updates this table to `applied` or
-- `failed`. The command trail remains in device_commands.

CREATE TABLE IF NOT EXISTS device_config_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  imei TEXT NOT NULL,
  vehicle_id UUID REFERENCES vehicles(id),
  param_id INTEGER NOT NULL,
  feature_key TEXT,
  value JSONB,
  desired_value JSONB,
  applied_value JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
  command_id UUID REFERENCES device_commands(id),
  requested_by UUID REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  response_text TEXT,
  preset_key TEXT,
  preset_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (imei, param_id)
);

-- Command queue/audit fields used by the bridge and operator UI.
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS raw_command TEXT;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS response_payload JSONB;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_status_check;
ALTER TABLE device_commands ADD CONSTRAINT device_commands_status_check
  CHECK (status IN ('queued', 'sent', 'applied', 'acked', 'acknowledged', 'failed', 'expired'));

ALTER TABLE device_config_state ADD COLUMN IF NOT EXISTS desired_value JSONB;
ALTER TABLE device_config_state ADD COLUMN IF NOT EXISTS applied_value JSONB;
ALTER TABLE device_config_state ADD COLUMN IF NOT EXISTS preset_key TEXT;
ALTER TABLE device_config_state ADD COLUMN IF NOT EXISTS preset_metadata JSONB;

UPDATE device_commands SET created_by = requested_by WHERE created_by IS NULL;
UPDATE device_commands SET updated_at = COALESCE(acked_at, sent_at, created_at) WHERE updated_at IS NULL;
UPDATE device_commands SET response_payload = to_jsonb(response_text) WHERE response_payload IS NULL AND response_text IS NOT NULL;
UPDATE device_config_state SET desired_value = value WHERE desired_value IS NULL;
UPDATE device_config_state SET applied_value = value WHERE status = 'applied' AND applied_value IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_config_state_imei
  ON device_config_state(imei, updated_at DESC);

-- Remote-configuration presets. These are seeded defaults; verify the IDs
-- against the tracker firmware in Settings → Teltonika Parameter Map.
INSERT INTO param_map (feature_key, param_id, description) VALUES
  ('reporting_interval',              100,  'Periodic data-send interval (seconds)'),
  ('data_acquisition_ignition_on',    104,  'Data acquisition period with ignition ON (seconds)'),
  ('data_acquisition_ignition_off',   102,  'Data acquisition period with ignition OFF (seconds)'),
  ('ignition_source',                 1000, 'Ignition source selection'),
  ('digital_output_control',          1028, 'Digital output (DOUT1) control')
ON CONFLICT (feature_key, param_id) DO NOTHING;
