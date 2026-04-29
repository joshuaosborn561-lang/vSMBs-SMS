-- Outbound/inbound SMS timeline for dashboard (delays, previews, variables snapshot).
CREATE TABLE IF NOT EXISTS sms_message_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  body TEXT NOT NULL,
  template_key TEXT,
  variables JSONB,
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('scheduled', 'sent', 'failed')),
  error_message TEXT,
  delay_ms_since_previous_outbound INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sms_message_log_client_created ON sms_message_log(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_message_log_client_phone ON sms_message_log(client_id, lead_phone, created_at DESC);
