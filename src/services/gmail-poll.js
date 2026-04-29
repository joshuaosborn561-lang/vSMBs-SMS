const db = require('../db');
const sheets = require('../services/sheets');
const gmailWatch = require('../services/gmail-watch');
const slack = require('../services/slack');

function parseIsoMs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Poll Gmail for clients with Sheets + Gmail connected; notify Slack once per message */
async function pollAllClients() {
  const { rows: clients } = await db.query(
    `SELECT * FROM clients WHERE active = true
       AND google_sheet_id IS NOT NULL
       AND gmail_refresh_token IS NOT NULL`
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
  const spreadsheetId = client.google_sheet_id;
  const emailLogTab = client.sheet_tab_email_log || 'EmailLog';

  let sinceMs = parseIsoMs(client.gmail_watcher_started_at);
  const cell = await sheets.getSettingCell(spreadsheetId, client);
  const cellMs = parseIsoMs(cell.value);
  sinceMs = Math.max(sinceMs || 0, cellMs || 0);

  if (!sinceMs) {
    console.warn('[GmailPoll] No since timestamp — set gmail_watcher_started_at or Settings cell', {
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

    let sheetRowNum = null;
    try {
      const app = await sheets.appendEmailLogPending(spreadsheetId, emailLogTab, {
        timestamp: new Date().toISOString(),
        senderEmail: msg.senderEmail,
        senderName: msg.senderName,
        subject: msg.subject,
        gmailMessageId: msg.id,
      });
      sheetRowNum = app.rowNum;
    } catch (e) {
      console.error('[GmailPoll] Sheet append failed', e.message);
    }

    await db.query(
      'UPDATE gmail_notifications SET sheet_log_row = $1 WHERE id = $2',
      [sheetRowNum, notif.id]
    );

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
  await sheets.setLastEmailCheckIso(spreadsheetId, client, nowIso);
}

module.exports = { pollAllClients, pollOneClient };
