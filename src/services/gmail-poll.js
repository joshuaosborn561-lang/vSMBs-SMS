const db = require('../db');
const gmailWatch = require('../services/gmail-watch');
const slack = require('../services/slack');
const gmailEmailLog = require('../services/gmail-email-log');

function parseIsoMs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

async function pollAllClients() {
  const { rows: clients } = await db.query(
    `SELECT * FROM clients WHERE active = true AND gmail_refresh_token IS NOT NULL`
  );

  for (const client of clients) {
    try {
      await pollOneClient(client);
    } catch (err) {
      console.error('[GmailPoll] Client failed', { clientId: client.id, err: err.message });
    }
  }
}

async function pollOneClient(client) {
  let sinceMs = parseIsoMs(client.gmail_watcher_started_at);
  const lastChecked = parseIsoMs(client.gmail_last_checked_at);
  sinceMs = Math.max(sinceMs || 0, lastChecked || 0);

  if (!sinceMs) {
    console.warn('[GmailPoll] No since timestamp — set gmail_watcher_started_at or gmail_last_checked_at', {
      clientId: client.id,
    });
    return;
  }

  const messages = await gmailWatch.pollUnreadSince(client.gmail_refresh_token, sinceMs);
  for (const msg of messages) {
    const already = await db.query(
      'SELECT id FROM gmail_notifications WHERE client_id = $1 AND gmail_message_id = $2',
      [client.id, msg.id]
    );
    if (already.rows.length) continue;

    const { rows: [notif] } = await db.query(
      `INSERT INTO gmail_notifications (client_id, gmail_message_id)
       VALUES ($1, $2) RETURNING *`,
      [client.id, msg.id]
    );

    await gmailEmailLog.insertInboundEmail(client.id, {
      gmail_message_id: msg.id,
      sender_email: msg.senderEmail || null,
      sender_name: msg.senderName || null,
      subject: msg.subject || null,
      body_preview: (msg.body || msg.snippet || '').slice(0, 8000),
    });

    const slackResult = await slack.postGmailInbound(client.slack_bot_token, client.slack_channel_id, {
      notificationId: notif.id,
      senderName: msg.senderName,
      senderEmail: msg.senderEmail,
      subject: msg.subject,
      body: msg.body || msg.snippet,
    });

    await db.query(
      `UPDATE gmail_notifications SET slack_metadata = $1 WHERE id = $2`,
      [JSON.stringify({ channel: slackResult.channel, ts: slackResult.ts }), notif.id]
    );
  }

  const nowIso = new Date().toISOString();
  await db.query(
    `UPDATE clients SET gmail_last_checked_at = $1::timestamptz, updated_at = now() WHERE id = $2`,
    [nowIso, client.id]
  );
}

module.exports = { pollAllClients, pollOneClient };
