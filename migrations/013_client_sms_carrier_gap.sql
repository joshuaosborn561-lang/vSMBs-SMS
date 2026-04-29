ALTER TABLE clients ADD COLUMN IF NOT EXISTS sms_min_gap_between_texts_ms INTEGER NOT NULL DEFAULT 60000;

COMMENT ON COLUMN clients.sms_min_gap_between_texts_ms IS 'Minimum milliseconds between any two outbound SMS for this client (carrier safety); enforced globally across sequences and manual sends.';
