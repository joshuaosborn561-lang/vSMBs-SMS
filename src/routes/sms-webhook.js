const { Router } = require('express');
const db = require('../db');
const sheets = require('../services/sheets');
const { classifySmsIntent, classifyAffirmative } = require('../services/classifier-sms');
const slack = require('../services/slack');
const { sendSms } = require('../services/sms-gateway');

const router = Router();

const FREE_SITE_MESSAGE = "I actually made you a site for free — want me to send it to you?";

function canonicalPhone(rawPhone, fallbackKeys) {
  const s = String(rawPhone || '').trim();
  if (s) return s;
  if (fallbackKeys && fallbackKeys.length) return fallbackKeys[0];
  return '';
}

function getCell(headers, row, ...names) {
  for (const n of names) {
    const k = n.toLowerCase().replace(/\s+/g, '_');
    const idx = headers[k];
    if (idx !== undefined && row[idx] != null) return String(row[idx]).trim();
  }
  return '';
}

router.post('/webhook/sms/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const payload = req.body || {};

  // SMSMobileAPI inbound: number, message, time_received, guid
  const rawPhone =
    payload.number || payload.from || payload.phone || payload.From || payload.sender || payload.msisdn;
  const inboundMessage =
    String(payload.message || payload.body || payload.text || payload.Body || '').trim();
  const timeReceived = payload.time_received || null;
  const inboundGuid = payload.guid || null;

  console.log('[Webhook SMS] inbound', {
    clientId, rawPhone, len: inboundMessage.length, guid: inboundGuid, time_received: timeReceived,
  });

  try {
    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client || !client.active) {
      return res.status(200).json({ ok: true, skipped: true });
    }

    if (!client.google_sheet_id) {
      console.warn('[Webhook SMS] No google_sheet_id on client', { clientId });
      return res.status(200).json({ ok: true, skipped: true, reason: 'no_sheet' });
    }

    const prospectTab = client.sheet_tab_prospects || 'Prospects';
    const dncTab = client.sheet_tab_dnc || 'DNC';

    const dncKeys = await sheets.loadDncPhoneKeys(client.google_sheet_id, dncTab);
    const keys = sheets.phoneMatchKeys(rawPhone);
    if (keys.some((k) => dncKeys.has(k))) {
      console.log('[Webhook SMS] Number on DNC list — ignoring', { rawPhone });
      return res.status(200).json({ ok: true, skipped: true, reason: 'dnc' });
    }

    const { row: sheetRow, headers, rowData } = await sheets.findProspectRow(
      client.google_sheet_id,
      prospectTab,
      rawPhone
    );

    const businessName = rowData ? getCell(headers, rowData, 'business_name', 'business name') : '';
    const vertical = rowData ? getCell(headers, rowData, 'vertical') : '';
    const city = rowData ? getCell(headers, rowData, 'city') : '';

    const ctxLines = [
      businessName && `Business: ${businessName}`,
      vertical && `Vertical: ${vertical}`,
      city && `City: ${city}`,
    ];

    const phoneDisplay = canonicalPhone(rawPhone, keys);

    // ─── Stage: awaiting ack after free-site prompt ───────────────────
    const { rows: [convState] } = await db.query(
      `SELECT * FROM sms_conversation_state WHERE client_id = $1 AND phone_e164 = $2`,
      [clientId, phoneDisplay]
    );

    if (convState?.stage === 'awaiting_free_site_ack') {
      const isYes = await classifyAffirmative(inboundMessage);
      await db.query(
        `UPDATE sms_conversation_state SET stage = 'idle', updated_at = now()
         WHERE client_id = $1 AND phone_e164 = $2`,
        [clientId, phoneDisplay]
      );

      if (isYes) {
        const { rows: [reply] } = await db.query(
          `INSERT INTO pending_replies
            (client_id, platform, lead_id, lead_name, lead_email, inbound_message, thread_context, classification, draft_reply, status)
           VALUES ($1, 'sms', $2, $3, $4, $5, $6, 'FREE_SITE_AFFIRMATIVE', $7, 'alert_only') RETURNING *`,
          [
            clientId,
            phoneDisplay,
            businessName || 'Unknown',
            null,
            inboundMessage,
            JSON.stringify({ businessName, vertical, city, phone: phoneDisplay }),
            null,
          ]
        );

        if (sheetRow) {
          await sheets.updateProspectByHeaders(
            client.google_sheet_id,
            prospectTab,
            sheetRow,
            headers,
            { reply: inboundMessage, intent: 'affirmative_free_site' }
          );
        }

        const slackResult = await slack.postSmsFollowupAlert(client.slack_bot_token, client.slack_channel_id, {
          replyId: reply.id,
          phone: phoneDisplay,
          businessName,
          vertical,
          city,
          inboundMessage,
        });
        await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [
          slackResult.ts,
          reply.id,
        ]);

        return res.status(200).json({ ok: true, path: 'free_site_affirmative' });
      }

      // Not affirmative after prompt — re-classify as new inbound
    }

    // ─── Classify with OpenAI ───────────────────────────────────────
    let intent;
    let reasoning;
    try {
      const c = await classifySmsIntent(inboundMessage, ctxLines);
      intent = c.intent;
      reasoning = c.reasoning;
    } catch (err) {
      console.error('[Classifier SMS] failed', err.message);
      intent = 'unclassifiable';
      reasoning = err.message;
    }

    if (sheetRow) {
      const log = { reply: inboundMessage, intent };
      if (intent === 'negative') log.customer_status = 'dnc';
      await sheets.updateProspectByHeaders(
        client.google_sheet_id,
        prospectTab,
        sheetRow,
        headers,
        log
      );
    }

    if (intent === 'negative') {
      await sheets.appendDnc(client.google_sheet_id, dncTab, {
        phone: phoneDisplay,
        reason: 'negative_sms',
      });
      if (sheetRow) {
        await sheets.updateProspectByHeaders(
          client.google_sheet_id,
          prospectTab,
          sheetRow,
          headers,
          { customer_status: 'dnc', dnc: 'yes' }
        );
      }
      return res.status(200).json({ ok: true, intent: 'negative' });
    }

    if (intent === 'question' || intent === 'unclassifiable') {
      const { rows: [reply] } = await db.query(
        `INSERT INTO pending_replies
          (client_id, platform, lead_id, lead_name, inbound_message, thread_context, classification, draft_reply, status)
         VALUES ($1, 'sms', $2, $3, $4, $5, $6, $7, 'pending') RETURNING *`,
        [
          clientId,
          phoneDisplay,
          businessName || 'Unknown',
          inboundMessage,
          JSON.stringify({ businessName, vertical, city, phone: phoneDisplay }),
          intent.toUpperCase(),
          null,
        ]
      );

      const slackResult = await slack.postSmsEscalation(client.slack_bot_token, client.slack_channel_id, {
        replyId: reply.id,
        phone: phoneDisplay,
        businessName,
        vertical,
        city,
        intent,
        inboundMessage,
        reasoning,
      });
      await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [
        slackResult.ts,
        reply.id,
      ]);

      return res.status(200).json({ ok: true, intent, replyId: reply.id });
    }

    // positive — no Slack; auto follow-up after delay; log inbound to sheet now
    if (sheetRow) {
      await sheets.updateProspectByHeaders(client.google_sheet_id, prospectTab, sheetRow, headers, {
        reply: inboundMessage,
        intent: 'positive',
        sent_status: 'awaiting_free_site_prompt',
      });
    }

    await db.query(
      `INSERT INTO sms_conversation_state (client_id, phone_e164, stage, updated_at)
       VALUES ($1, $2, 'awaiting_free_site_ack', now())
       ON CONFLICT (client_id, phone_e164)
       DO UPDATE SET stage = 'awaiting_free_site_ack', updated_at = now()`,
      [clientId, phoneDisplay]
    );

    setTimeout(async () => {
      try {
        await sendSms({ to: phoneDisplay, body: FREE_SITE_MESSAGE });

        if (sheetRow) {
          await sheets.updateProspectByHeaders(
            client.google_sheet_id,
            prospectTab,
            sheetRow,
            headers,
            {
              customer_status: 'free_site_prompt_sent',
              sent_status: 'free_site_prompt_sent',
            }
          );
        }

        await db.query(
          `INSERT INTO pending_replies
            (client_id, platform, lead_id, lead_name, inbound_message, thread_context, classification, draft_reply, status, sent_reply)
           VALUES ($1, 'sms', $2, $3, $4, $5, 'POSITIVE_FOLLOWUP', $6, 'sent', $6)`,
          [
            clientId,
            phoneDisplay,
            businessName || 'Unknown',
            '(automated follow-up)',
            JSON.stringify({ note: 'auto free-site SMS', phone: phoneDisplay }),
            FREE_SITE_MESSAGE,
          ]
        );

        console.log('[Webhook SMS] Sent free-site follow-up', { phone: phoneDisplay });
      } catch (err) {
        console.error('[Webhook SMS] Delayed send failed', err.message);
        try {
          await slack.postSmsAutomationFailed(client.slack_bot_token, client.slack_channel_id, {
            phone: phoneDisplay,
            businessName: businessName || 'Unknown',
            error: err.message,
          });
        } catch (e) {
          console.error('[Webhook SMS] Failed to post Slack alert for send failure', e.message);
        }
      }
    }, 20000);

    res.status(200).json({ ok: true, intent: 'positive', scheduled: true });
  } catch (err) {
    console.error('[Webhook SMS] error', err.message, err.stack);
    res.status(200).json({ ok: true, error: err.message });
  }
});

module.exports = router;
