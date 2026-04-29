-- Outbound SMS now uses SMSMobileAPI (SMSMOBILEAPI_KEY env); per-client gateway columns removed.
ALTER TABLE clients DROP COLUMN IF EXISTS sms_gateway_url;
ALTER TABLE clients DROP COLUMN IF EXISTS sms_gateway_api_key;
