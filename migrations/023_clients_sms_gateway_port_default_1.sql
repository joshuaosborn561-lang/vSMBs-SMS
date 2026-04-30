-- Default outbound SIM to slot 1 (SMSMobileAPI sendsms `port=1`).
UPDATE clients SET sms_gateway_port = 1 WHERE sms_gateway_port IS NULL;
ALTER TABLE clients ALTER COLUMN sms_gateway_port SET DEFAULT 1;
ALTER TABLE clients ALTER COLUMN sms_gateway_port SET NOT NULL;

COMMENT ON COLUMN clients.sms_gateway_port IS 'SMSMobileAPI sendsms port: 1 or 2 for SIM slot; default 1';
