-- Soft-delete column for campaign workspaces. Rows with archived_at IS NOT NULL
-- are hidden from /admin/campaigns and excluded from sends.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_clients_archived_at ON clients(archived_at);
