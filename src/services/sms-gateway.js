/**
 * Outbound SMS via SMSMobileAPI (smsmobileapi.com).
 * API key: Railway env SMSMOBILEAPI_KEY
 * @see https://api.smsmobileapi.com/sendsms/
 */
const SEND_URL = 'https://api.smsmobileapi.com/sendsms/';

async function sendSms({ to, body }) {
  const apikey = (process.env.SMSMOBILEAPI_KEY || '').trim();
  if (!apikey) throw new Error('SMSMOBILEAPI_KEY is not set');

  const params = new URLSearchParams({
    apikey,
    recipients: String(to || '').trim(),
    message: String(body || ''),
  });

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
