const db = require('../db');
const { sendSms } = require('./sms-gateway');

async function getSmsGatewayOptionsForClient(clientId) {
  const { rows: [row] } = await db.query(
    `SELECT sms_gateway_port, sms_gateway_device_sid FROM clients WHERE id = $1`,
    [clientId]
  );
  if (!row) return { port: 1 };
  const rawPort = row.sms_gateway_port != null ? Number(row.sms_gateway_port) : 1;
  const port = rawPort === 2 ? 2 : 1;
  const sid = row.sms_gateway_device_sid != null ? String(row.sms_gateway_device_sid).trim() : '';
  return {
    port,
    sIdentifiant: sid || undefined,
  };
}

/** Serialized sends per client + last successful SMS time for carrier-safe spacing */
const clientOutboundTail = new Map();
const lastClientOutboundSentAt = new Map();
const minGapCache = new Map();

async function getMinGapMsForClient(clientId) {
  const now = Date.now();
  const cached = minGapCache.get(clientId);
  if (cached && now - cached.at < 30000) return cached.ms;

  const { rows: [row] } = await db.query(
    `SELECT COALESCE(sms_min_gap_between_texts_ms, 0)::int AS g FROM clients WHERE id = $1`,
    [clientId]
  );
  const ms = Math.max(0, Number(row?.g) || 0);
  minGapCache.set(clientId, { ms, at: now });
  return ms;
}

function invalidateClientMinGapCache(clientId) {
  minGapCache.delete(clientId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitCarrierGapIfNeeded(clientId) {
  const gapMs = await getMinGapMsForClient(clientId);
  if (!gapMs) return;
  const last = lastClientOutboundSentAt.get(clientId) || 0;
  const elapsed = Date.now() - last;
  const wait = gapMs - elapsed;
  if (wait > 0) await sleep(wait);
}

function queueClientOutbound(clientId, fn) {
  const prev = clientOutboundTail.get(clientId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  clientOutboundTail.set(clientId, next.catch(() => {}));
  return next;
}

async function lastOutboundSentAt(clientId, leadPhone) {
  const { rows } = await db.query(
    `SELECT sent_at FROM sms_message_log
     WHERE client_id = $1 AND lead_phone = $2 AND direction = 'outbound'
       AND status = 'sent' AND sent_at IS NOT NULL
     ORDER BY sent_at DESC LIMIT 1`,
    [clientId, leadPhone]
  );
  return rows[0]?.sent_at ? new Date(rows[0].sent_at) : null;
}

async function computeDelayMsSinceLastOutbound(clientId, leadPhone) {
  const last = await lastOutboundSentAt(clientId, leadPhone);
  if (!last) return null;
  return Math.max(0, Date.now() - last.getTime());
}

async function logInbound({ clientId, leadPhone, body, variables }) {
  const { rows: [row] } = await db.query(
    `INSERT INTO sms_message_log
      (client_id, lead_phone, direction, body, template_key, variables, status, sent_at)
     VALUES ($1, $2, 'inbound', $3, NULL, $4::jsonb, 'sent', now()) RETURNING id`,
    [clientId, leadPhone, body, JSON.stringify(variables || {})]
  );
  return row?.id;
}

async function updateInboundMeta(logId, { sentimentLabel, sentimentScore, stopRequest }) {
  if (!logId) return;
  await db.query(
    `UPDATE sms_message_log SET
       sentiment_label = $2,
       sentiment_score = $3,
       stop_request = $4
     WHERE id = $1`,
    [logId, sentimentLabel ?? null, sentimentScore ?? null, !!stopRequest]
  );
}

/** Queued auto follow-up (20s delay) — returns log row id */
async function logOutboundScheduled({ clientId, leadPhone, body, templateKey, variables }) {
  const { rows: [row] } = await db.query(
    `INSERT INTO sms_message_log
      (client_id, lead_phone, direction, body, template_key, variables, status, created_at)
     VALUES ($1, $2, 'outbound', $3, $4, $5::jsonb, 'scheduled', now()) RETURNING id`,
    [clientId, leadPhone, body, templateKey || null, JSON.stringify(variables || {})]
  );
  return row.id;
}

async function logOutboundSent({ clientId, leadPhone, body, templateKey, variables, providerMessageId, logId }) {
  const delayMs = await computeDelayMsSinceLastOutbound(clientId, leadPhone);

  if (logId) {
    await db.query(
      `UPDATE sms_message_log SET
         status = 'sent',
         sent_at = now(),
         provider_message_id = $1,
         delay_ms_since_previous_outbound = $2,
         body = $3
       WHERE id = $4`,
      [providerMessageId || null, delayMs, body, logId]
    );
    return;
  }

  await db.query(
    `INSERT INTO sms_message_log
      (client_id, lead_phone, direction, body, template_key, variables, provider_message_id,
       status, delay_ms_since_previous_outbound, sent_at)
     VALUES ($1, $2, 'outbound', $3, $4, $5::jsonb, $6, 'sent', $7, now())`,
    [
      clientId,
      leadPhone,
      body,
      templateKey || null,
      JSON.stringify(variables || {}),
      providerMessageId || null,
      delayMs,
    ]
  );
}

async function logOutboundFailed({ logId, errorMessage }) {
  if (!logId) return;
  await db.query(
    `UPDATE sms_message_log SET status = 'failed', error_message = $1, sent_at = now() WHERE id = $2`,
    [String(errorMessage || '').slice(0, 2000), logId]
  );
}

/** Send via SMSMobileAPI and finalize log row (or insert if no scheduledLogId). Carrier gap enforced per client (serialized). */
async function sendSmsLogged({ clientId, leadPhone, body, templateKey, variables, scheduledLogId }) {
  return queueClientOutbound(clientId, async () => {
    try {
      await waitCarrierGapIfNeeded(clientId);
      const gw = await getSmsGatewayOptionsForClient(clientId);
      const r = await sendSms({ to: leadPhone, body, ...gw });
      lastClientOutboundSentAt.set(clientId, Date.now());
      await logOutboundSent({
        clientId,
        leadPhone,
        body,
        templateKey,
        variables,
        providerMessageId: r.id,
        logId: scheduledLogId,
      });
      return r;
    } catch (e) {
      await logOutboundFailed({ logId: scheduledLogId, errorMessage: e.message });
      throw e;
    }
  });
}

async function listLog(clientId, limit = 100) {
  const { rows } = await db.query(
    `SELECT * FROM sms_message_log
     WHERE client_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [clientId, Math.min(500, Math.max(1, limit))]
  );
  return rows;
}

/** Recent SMS across all campaigns (master inbox) */
async function listLogMaster(limit = 80) {
  const lim = Math.min(200, Math.max(1, limit));
  const { rows } = await db.query(
    `SELECT l.*, c.name AS campaign_name
     FROM sms_message_log l
     JOIN clients c ON c.id = l.client_id
     ORDER BY COALESCE(l.sent_at, l.created_at) DESC NULLS LAST
     LIMIT $1`,
    [lim]
  );
  return rows;
}

module.exports = {
  getSmsGatewayOptionsForClient,
  logInbound,
  updateInboundMeta,
  logOutboundScheduled,
  logOutboundSent,
  logOutboundFailed,
  sendSmsLogged,
  listLog,
  listLogMaster,
  computeDelayMsSinceLastOutbound,
  invalidateClientMinGapCache,
};
