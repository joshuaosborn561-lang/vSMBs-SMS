/**
 * Outbound SMS via your HTTP gateway (Android SMS Gateway or compatible).
 * Configure per client: sms_gateway_url, sms_gateway_api_key.
 */
async function sendSms({ baseUrl, apiKey, to, body }) {
  if (!baseUrl) throw new Error('sms_gateway_url not configured for client');
  const url = baseUrl.replace(/\/$/, '') + '/send';

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const payloads = [
    { to, body, message: body, phone: to, text: body },
    { number: to, message: body },
  ];

  let lastErr;
  for (const payload of payloads) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (res.ok) return { ok: true, status: res.status, body: text };
      lastErr = new Error(`SMS gateway ${res.status}: ${text.slice(0, 500)}`);
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('SMS gateway request failed');
}

module.exports = { sendSms };
