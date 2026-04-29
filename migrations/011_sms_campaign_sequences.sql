-- SMS outbound sequences (SmartLead-style): steps + enrollments + send queue

CREATE TABLE sms_campaign (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Campaign',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sms_campaign_client ON sms_campaign(client_id);

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
