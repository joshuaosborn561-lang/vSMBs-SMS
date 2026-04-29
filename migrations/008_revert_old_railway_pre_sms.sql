-- Revert SMS / Sheets / Gmail watcher schema on legacy DB (SmartLead + HeyReach only).
-- Safe if no sms rows exist (DELETE is no-op).

DELETE FROM pending_replies WHERE platform = 'sms';

DROP TABLE IF EXISTS gmail_notifications;
DROP TABLE IF EXISTS sms_conversation_state;

ALTER TABLE clients DROP COLUMN IF EXISTS google_sheet_id;
ALTER TABLE clients DROP COLUMN IF EXISTS sheet_tab_prospects;
ALTER TABLE clients DROP COLUMN IF EXISTS sheet_tab_dnc;
ALTER TABLE clients DROP COLUMN IF EXISTS sheet_tab_settings;
ALTER TABLE clients DROP COLUMN IF EXISTS sheet_tab_email_log;
ALTER TABLE clients DROP COLUMN IF EXISTS settings_last_email_check_cell;
ALTER TABLE clients DROP COLUMN IF EXISTS gmail_refresh_token;
ALTER TABLE clients DROP COLUMN IF EXISTS gmail_address;
ALTER TABLE clients DROP COLUMN IF EXISTS gmail_watcher_started_at;

ALTER TABLE pending_replies DROP CONSTRAINT IF EXISTS pending_replies_platform_check;
ALTER TABLE pending_replies ADD CONSTRAINT pending_replies_platform_check
  CHECK (platform IN ('smartlead', 'heyreach'));
