-- Schedule, lifecycle, daily caps, branching, staged leads, sentiment on inbound log

ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('draft', 'active', 'paused', 'archived'));

UPDATE sms_campaign SET status = CASE WHEN active THEN 'active' ELSE 'paused' END;

ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';
ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS schedule_days INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5];
ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS schedule_start TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS schedule_end TEXT NOT NULL DEFAULT '17:00';
ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS min_gap_between_sends_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS max_sends_per_day INTEGER;
ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS max_new_enrollments_per_day INTEGER;
ALTER TABLE sms_campaign ADD COLUMN IF NOT EXISTS exclude_other_campaigns BOOLEAN NOT NULL DEFAULT true;

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

ALTER TABLE sms_message_log ADD COLUMN IF NOT EXISTS sentiment_label TEXT;
ALTER TABLE sms_message_log ADD COLUMN IF NOT EXISTS sentiment_score REAL;
ALTER TABLE sms_message_log ADD COLUMN IF NOT EXISTS stop_request BOOLEAN NOT NULL DEFAULT false;
