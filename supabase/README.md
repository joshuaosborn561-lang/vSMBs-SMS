# Reply Handler — Supabase (separate from CRM)

Use a **dedicated Supabase project** for this app (`sms_prospect`, `campaign_event_log`, `gmail_inbound_email`). Do **not** point Railway at your CRM Supabase — keep data isolated until you integrate.

## Automated (CLI)

With `supabase login` and Railway GraphQL env (`RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`):

```bash
node scripts/provision-reply-handler-supabase.mjs
```

Creates a new project, links it, runs **`schema-reference.sql`**, and sets **`SUPABASE_URL`** + **`SUPABASE_SERVICE_ROLE_KEY`** on the Railway app service (triggers a deploy unless `SKIP_DEPLOY=true`).

## Manual setup

1. Supabase Dashboard → **New project**.
2. `npx supabase link --project-ref <REF>`
3. `npx supabase db query --linked -f supabase/schema-reference.sql`
4. Copy **Project URL** + **service_role** key → Railway variables.

## Integration with CRM later

Sync via jobs/APIs; optional bridge columns (e.g. `crm_contact_id`) can be added in **this** Supabase project only.

## Files

- **`schema-reference.sql`** — three tables (`IF NOT EXISTS`).
