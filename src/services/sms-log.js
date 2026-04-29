const db = require('../db');
const { sendSms } = require('./sms-gateway');

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

/** Send via SMSMobileAPI and finalize log row (or insert if no scheduledLogId). */
async function sendSmsLogged({ clientId, leadPhone, body, templateKey, variables, scheduledLogId }) {
  try {
    const r = await sendSms({ to: leadPhone, body });
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

module.exports = {
  logInbound,
  updateInboundMeta,
  logOutboundScheduled,
  logOutboundSent,
  logOutboundFailed,
  sendSmsLogged,
  listLog,
  computeDelayMsSinceLastOutbound,
};
