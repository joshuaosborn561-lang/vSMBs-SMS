-- Default minimum gap between outbound SMS = 60 seconds (carrier safety)

ALTER TABLE clients ALTER COLUMN sms_min_gap_between_texts_ms SET DEFAULT 60000;
