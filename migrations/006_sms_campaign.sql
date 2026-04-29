-- SMS cold outreach + Gmail watcher support

ALTER TABLE pending_replies DROP CONSTRAINT IF EXISTS pending_replies_platform_check;
ALTER TABLE pending_replies ADD CONSTRAINT pending_replies_platform_check
  CHECK (platform IN ('smartlead', 'heyreach', 'sms'));

ALTER TABLE clients ADD COLUMN IF NOT EXISTS google_sheet_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sheet_tab_prospects TEXT DEFAULT 'Prospects';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sheet_tab_dnc TEXT DEFAULT 'DNC';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sheet_tab_settings TEXT DEFAULT 'Settings';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sheet_tab_email_log TEXT DEFAULT 'EmailLog';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS settings_last_email_check_cell TEXT DEFAULT 'B2';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS gmail_refresh_token TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS gmail_address TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS gmail_watcher_started_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS sms_conversation_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'idle' CHECK (stage IN ('idle', 'awaiting_free_site_ack')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS idx_sms_conv_client_phone ON sms_conversation_state(client_id, phone_e164);

CREATE TABLE IF NOT EXISTS gmail_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  sheet_log_row INTEGER,
  slack_metadata JSONB,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ,
  UNIQUE (client_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_gmail_notifications_client ON gmail_notifications(client_id);
