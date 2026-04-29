CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  smartlead_api_key TEXT,
  heyreach_api_key TEXT,
  slack_bot_token TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  booking_link TEXT,
  calendly_personal_access_token TEXT,
  voice_prompt TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  google_sheet_id TEXT,
  sheet_tab_prospects TEXT DEFAULT 'Prospects',
  sheet_tab_dnc TEXT DEFAULT 'DNC',
  sheet_tab_settings TEXT DEFAULT 'Settings',
  sheet_tab_email_log TEXT DEFAULT 'EmailLog',
  settings_last_email_check_cell TEXT DEFAULT 'B2',
  gmail_refresh_token TEXT,
  gmail_address TEXT,
  gmail_watcher_started_at TIMESTAMPTZ,
  sms_free_site_body TEXT,
  sms_free_site_delay_ms INTEGER NOT NULL DEFAULT 20000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pending_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  platform TEXT NOT NULL CHECK (platform IN ('smartlead', 'heyreach', 'sms')),
  campaign_id TEXT,
  lead_id TEXT,
  lead_name TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  inbound_message TEXT NOT NULL,
  thread_context JSONB,
  classification TEXT NOT NULL,
  draft_reply TEXT,
  sent_reply TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'flagged', 'alert_only')),
  slack_message_ts TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  pending_reply_id UUID REFERENCES pending_replies(id),
  lead_name TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  proposed_time TEXT,
  confirmed_time TIMESTAMPTZ,
  calendar_event_id TEXT,
  calendar_provider TEXT,
  meeting_link TEXT,
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'booked', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  email TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, provider)
);

CREATE INDEX idx_pending_replies_client_id ON pending_replies(client_id);
CREATE INDEX idx_pending_replies_status ON pending_replies(status);
CREATE INDEX idx_meetings_client_id ON meetings(client_id);
CREATE INDEX idx_meetings_status ON meetings(status);

CREATE TABLE sms_conversation_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'idle' CHECK (stage IN ('idle', 'awaiting_free_site_ack')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, phone_e164)
);

CREATE INDEX idx_sms_conv_client_phone ON sms_conversation_state(client_id, phone_e164);

CREATE TABLE gmail_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  sheet_log_row INTEGER,
  slack_metadata JSONB,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ,
  UNIQUE (client_id, gmail_message_id)
);

CREATE INDEX idx_gmail_notifications_client ON gmail_notifications(client_id);

CREATE TABLE sms_message_log (
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
  sentiment_label TEXT,
  sentiment_score REAL,
  stop_request BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX idx_sms_message_log_client_created ON sms_message_log(client_id, created_at DESC);
CREATE INDEX idx_sms_message_log_client_phone ON sms_message_log(client_id, lead_phone, created_at DESC);

CREATE TABLE sms_campaign (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Campaign',
  active BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  schedule_days INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  schedule_start TEXT NOT NULL DEFAULT '09:00',
  schedule_end TEXT NOT NULL DEFAULT '17:00',
  min_gap_between_sends_ms INTEGER NOT NULL DEFAULT 0,
  max_sends_per_day INTEGER,
  max_new_enrollments_per_day INTEGER,
  exclude_other_campaigns BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sms_campaign_client ON sms_campaign(client_id);

CREATE TABLE sms_campaign_daily_counters (
  campaign_id UUID NOT NULL REFERENCES sms_campaign(id) ON DELETE CASCADE,
  counter_date DATE NOT NULL,
  sends_count INTEGER NOT NULL DEFAULT 0,
  enrolls_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, counter_date)
);

CREATE INDEX idx_sms_campaign_daily_counter_date ON sms_campaign_daily_counters(counter_date);

CREATE TABLE sms_campaign_transition (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_campaign_id UUID NOT NULL REFERENCES sms_campaign(id) ON DELETE CASCADE,
  target_campaign_id UUID NOT NULL REFERENCES sms_campaign(id) ON DELETE CASCADE,
  trigger_intent TEXT NOT NULL CHECK (trigger_intent IN ('positive', 'negative', 'question', 'unclassifiable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, source_campaign_id, trigger_intent)
);

CREATE INDEX idx_sms_transition_source ON sms_campaign_transition(source_campaign_id);

CREATE TABLE sms_campaign_staged_lead (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '{}',
  source_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, phone)
);

CREATE INDEX idx_sms_staged_client ON sms_campaign_staged_lead(client_id, created_at DESC);

CREATE TABLE sms_campaign_step (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES sms_campaign(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  body_template TEXT NOT NULL,
  delay_after_ms INTEGER NOT NULL DEFAULT 86400000,
  UNIQUE (campaign_id, sort_order)
);

CREATE INDEX idx_sms_campaign_step_campaign ON sms_campaign_step(campaign_id, sort_order);

CREATE TABLE sms_campaign_enrollment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES sms_campaign(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_phone TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '{}',
  current_step INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused', 'cancelled', 'failed')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_phone)
);

CREATE INDEX idx_sms_enrollment_campaign ON sms_campaign_enrollment(campaign_id);
CREATE INDEX idx_sms_enrollment_client ON sms_campaign_enrollment(client_id);

CREATE TABLE sms_campaign_job_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES sms_campaign_enrollment(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES sms_campaign(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_phone TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sms_job_pending ON sms_campaign_job_queue(status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX idx_sms_job_enrollment ON sms_campaign_job_queue(enrollment_id);
