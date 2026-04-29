# Reply Handler — Supabase (separate from CRM)

Use a **dedicated Supabase project** for this app (`sms_prospect`, `campaign_event_log`, `gmail_inbound_email`). Do **not** point Railway env vars at your CRM Supabase project — keep data isolated until you deliberately integrate.

## Setup (new project)

1. In Supabase Dashboard: **New project** (e.g. “Reply Handler SMS”).
2. Locally (once):  
   `npx supabase link --project-ref <YOUR_NEW_PROJECT_REF>`
3. Apply tables:  
   `npx supabase db query --linked -f supabase/schema-reference.sql`
4. Railway / `.env`: **`SUPABASE_URL`** + **`SUPABASE_SERVICE_ROLE_KEY`** from **this** project only.

## Integration with CRM later

- Tables stay separate; sync via **scheduled jobs**, **Edge Functions**, or **CRM APIs** — not shared Postgres foreign keys across Supabase projects.
- If you need a mapping layer later, add columns or a small bridge table **in this project** (e.g. `crm_contact_id`) via a new migration SQL file here.

## Files

- **`schema-reference.sql`** — creates the three tables (`IF NOT EXISTS`). Safe to re-run.
