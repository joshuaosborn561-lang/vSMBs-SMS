/**
 * Outbound SMS via SMSMobileAPI (smsmobileapi.com).
 * API key: Railway env SMSMOBILEAPI_KEY
 * Optional SIM / device (per https://smsmobileapi.com/doc — sendsms):
 *   - port: 1 or 2 = SIM slot; omit for auto
 *   - sIdentifiant: linked phone id; omit for first available device
 * Env fallbacks: SMSMOBILEAPI_PORT, SMSMOBILEAPI_SIDENTIFIANT
 * @see https://api.smsmobileapi.com/sendsms/
 */
const SEND_URL = 'https://api.smsmobileapi.com/sendsms/';

function normalizeSimPort(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  if (n === 1 || n === 2) return String(n);
  return null;
}

function normalizeDeviceSid(raw) {
  const s = String(raw || '').trim();
  return s || null;
}

async function sendSms({ to, body, port, sIdentifiant } = {}) {
  const apikey = (process.env.SMSMOBILEAPI_KEY || '').trim();
  if (!apikey) throw new Error('SMSMOBILEAPI_KEY is not set');

  const simPort =
    normalizeSimPort(port) ??
    normalizeSimPort(process.env.SMSMOBILEAPI_PORT) ??
    '2';
  const deviceSid =
    normalizeDeviceSid(sIdentifiant) ??
    normalizeDeviceSid(process.env.SMSMOBILEAPI_SIDENTIFIANT);

  const params = new URLSearchParams({
    apikey,
    recipients: String(to || '').trim(),
    message: String(body || ''),
  });
  if (simPort) params.set('port', simPort);
  if (deviceSid) params.set('sIdentifiant', deviceSid);

  const url = `${SEND_URL}?${params.toString()}`;
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`SMSMobileAPI non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }

  const err = data?.result?.error;
  const ok = res.ok && (err === 0 || err === '0');
  if (!ok) {
    throw new Error(
      `SMSMobileAPI error: HTTP ${res.status}, result=${JSON.stringify(data?.result || data).slice(0, 400)}`
    );
  }

  return { ok: true, id: data?.result?.id, sent: data?.result?.sent };
}

module.exports = { sendSms };
