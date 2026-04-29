-- Reply Handler dedicated Supabase project — NOT the CRM database.
-- Apply here after `supabase link` to your **new** project (see supabase/README.md).
-- Keeps SMS prospects/events separate until you integrate with CRM (sync/API layer).

create extension if not exists pgcrypto;

create table if not exists sms_prospect (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  phone_e164 text not null,
  business_name text,
  vertical text,
  city text,
  sent_status text,
  reply text,
  intent text,
  site_url text,
  customer_status text,
  is_dnc boolean not null default false,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, phone_e164)
);

create index if not exists idx_sms_prospect_client on sms_prospect (client_id);
create index if not exists idx_sms_prospect_dnc on sms_prospect (client_id, is_dnc) where is_dnc = true;

create table if not exists campaign_event_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid,
  enrollment_id uuid,
  job_id uuid,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaign_event_client on campaign_event_log (client_id, created_at desc);

-- Gmail mirror (code uses table name gmail_inbound_email)
create table if not exists gmail_inbound_email (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  gmail_message_id text not null,
  sender_email text,
  sender_name text,
  subject text,
  body_preview text,
  status text not null default 'pending' check (status in ('pending', 'handled')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  unique (client_id, gmail_message_id)
);

create index if not exists idx_gmail_inbound_client on gmail_inbound_email (client_id, created_at desc);
