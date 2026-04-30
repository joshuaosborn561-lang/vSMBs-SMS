-- Allow saving incomplete campaign (workspace) rows before Slack is configured.
ALTER TABLE clients ALTER COLUMN slack_bot_token DROP NOT NULL;
ALTER TABLE clients ALTER COLUMN slack_channel_id DROP NOT NULL;
