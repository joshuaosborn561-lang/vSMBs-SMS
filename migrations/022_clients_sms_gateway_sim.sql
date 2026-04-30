-- Per-campaign SMSMobileAPI gateway: SIM slot (port) and optional device (sIdentifiant).
-- See https://smsmobileapi.com/doc — sendsms parameters `port` (1|2) and `sIdentifiant`.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sms_gateway_port SMALLINT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sms_gateway_device_sid TEXT;

COMMENT ON COLUMN clients.sms_gateway_port IS 'SMSMobileAPI sendsms port: 1 or 2 for SIM slot';
COMMENT ON COLUMN clients.sms_gateway_device_sid IS 'SMSMobileAPI sendsms sIdentifiant: linked phone device id; NULL = first available';
