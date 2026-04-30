-- Default outbound SIM to slot 2 (camp outreach); SIM 1 reserved as personal/main line.
UPDATE clients SET sms_gateway_port = 2;
ALTER TABLE clients ALTER COLUMN sms_gateway_port SET DEFAULT 2;

COMMENT ON COLUMN clients.sms_gateway_port IS 'SMSMobileAPI sendsms port: 1 or 2; default 2';
