-- Prospects + Gmail inbox copy now live in Supabase (sms_prospect, gmail_inbound_email).
-- Safe to run if you migrated to Supabase and no longer need duplicate rows in Railway Postgres.

DROP TABLE IF EXISTS gmail_client_email_log;
