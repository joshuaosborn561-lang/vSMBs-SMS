const { Router } = require('express');
const db = require('../db');
const sheets = require('../services/sheets');
const prospects = require('../services/prospects');
const {
  classifySmsIntent,
  classifyAffirmative,
  classifyInboundSentimentAndStop,
  looksLikeStopOrUnsubscribe,
} = require('../services/classifier-sms');
const slack = require('../services/slack');
const smsLog = require('../services/sms-log');
const smsCampaign = require('../services/sms-campaign');
const { renderSmsTemplate } = require('../utils/sms-template');

const router = Router();

const DEFAULT_FREE_SITE_TEMPLATE = "I actually made you a site for free — want me to send it to you?";

function canonicalPhone(rawPhone, fallbackKeys) {
  const s = String(rawPhone || '').trim();
  if (s) return s;
  if (fallbackKeys && fallbackKeys.length) return fallbackKeys[0];
  return '';
}

router.post('/webhook/sms/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const payload = req.body || {};

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

    const sheetKeys = sheets.phoneMatchKeys(rawPhone);

    if (await prospects.isPhoneOnDnc(clientId, rawPhone)) {
      console.log('[Webhook SMS] Number on DNC list — ignoring', { rawPhone });
      return res.status(200).json({ ok: true, skipped: true, reason: 'dnc' });
    }

    const { row: prospectRow } = await prospects.findProspectByPhone(clientId, rawPhone);
    const vars = prospectRow ? prospects.prospectRowToVariables(prospectRow) : {};
    const businessName = vars.business_name || '';
    const vertical = vars.vertical || '';
    const city = vars.city || '';

    const ctxLines = [
      businessName && `Business: ${businessName}`,
      vertical && `Vertical: ${vertical}`,
      city && `City: ${city}`,
    ];

    const phoneDisplay = canonicalPhone(rawPhone, sheetKeys);

    let inboundLogId;
    try {
      inboundLogId = await smsLog.logInbound({
        clientId,
        leadPhone: phoneDisplay,
        body: inboundMessage,
        variables: { guid: inboundGuid, time_received: timeReceived },
      });
    } catch (e) {
      console.warn('[Webhook SMS] sms log inbound skipped', e.message);
    }

    let sentiment = null;
    try {
      sentiment = await classifyInboundSentimentAndStop(inboundMessage);
      if (inboundLogId) {
        await smsLog.updateInboundMeta(inboundLogId, {
          sentimentLabel: sentiment.sentiment_label,
          sentimentScore: sentiment.sentiment_score,
          stopRequest: sentiment.stop_request,
        });
      }
    } catch (e) {
      console.warn('[Webhook SMS] sentiment skipped', e.message);
    }

    const stopDetected =
      sentiment?.stop_request ||
      looksLikeStopOrUnsubscribe(inboundMessage);

    if (stopDetected) {
      await smsCampaign.cancelJobsForPhone(clientId, phoneDisplay, 'stop_or_unsubscribe');
      await prospects.appendDnc(clientId, phoneDisplay, 'stop_unsubscribe_auto');
      await prospects.patchProspectFields(clientId, phoneDisplay, {
        reply: inboundMessage,
        intent: 'stop',
        customer_status: 'dnc',
        dnc: true,
      });
      return res.status(200).json({
        ok: true,
        path: 'auto_dnc_stop',
        sentiment: sentiment?.sentiment_label,
      });
    }

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

        await prospects.patchProspectFields(clientId, phoneDisplay, {
          reply: inboundMessage,
          intent: 'affirmative_free_site',
        });

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
    }

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

    try {
      const br = await smsCampaign.handleInboundBranch(clientId, phoneDisplay, intent);
      if (br.branched) {
        return res.status(200).json({
          ok: true,
          intent,
          branched: true,
          target_campaign_id: br.target_campaign_id,
          enroll: br.enroll,
        });
      }
    } catch (e) {
      console.warn('[Webhook SMS] branch handler', e.message);
    }

    await prospects.patchProspectFields(clientId, phoneDisplay, {
      reply: inboundMessage,
      intent,
      ...(intent === 'negative' ? { customer_status: 'dnc', dnc: true } : {}),
    });

    if (intent === 'negative') {
      await prospects.appendDnc(clientId, phoneDisplay, 'negative_sms');
      await smsCampaign.cancelJobsForPhone(clientId, phoneDisplay, 'intent_negative');
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

    await prospects.patchProspectFields(clientId, phoneDisplay, {
      reply: inboundMessage,
      intent: 'positive',
      sent_status: 'awaiting_free_site_prompt',
    });

    await db.query(
      `INSERT INTO sms_conversation_state (client_id, phone_e164, stage, updated_at)
       VALUES ($1, $2, 'awaiting_free_site_ack', now())
       ON CONFLICT (client_id, phone_e164)
       DO UPDATE SET stage = 'awaiting_free_site_ack', updated_at = now()`,
      [clientId, phoneDisplay]
    );

    const delayMs = Math.max(0, Number(client.sms_free_site_delay_ms) || 20000);
    const template =
      (client.sms_free_site_body && String(client.sms_free_site_body).trim()) || DEFAULT_FREE_SITE_TEMPLATE;
    const templateVars = {
      phone: phoneDisplay,
      business_name: businessName,
      vertical,
      city,
    };
    const renderedBody = renderSmsTemplate(template, templateVars);

    let scheduledLogId;
    try {
      scheduledLogId = await smsLog.logOutboundScheduled({
        clientId,
        leadPhone: phoneDisplay,
        body: renderedBody,
        templateKey: 'free_site_followup',
        variables: { ...templateVars, delay_ms: delayMs, template },
      });
    } catch (e) {
      console.warn('[Webhook SMS] scheduled log insert', e.message);
    }

    setTimeout(async () => {
      try {
        const { rows: [c2] } = await db.query('SELECT sms_free_site_body, sms_free_site_delay_ms FROM clients WHERE id = $1', [clientId]);
        const tpl =
          (c2?.sms_free_site_body && String(c2.sms_free_site_body).trim()) || DEFAULT_FREE_SITE_TEMPLATE;
        const bodyToSend = renderSmsTemplate(tpl, templateVars);

        await smsLog.sendSmsLogged({
          clientId,
          leadPhone: phoneDisplay,
          body: bodyToSend,
          templateKey: 'free_site_followup',
          variables: { ...templateVars, template: tpl },
          scheduledLogId,
        });

        await prospects.patchProspectFields(clientId, phoneDisplay, {
          customer_status: 'free_site_prompt_sent',
          sent_status: 'free_site_prompt_sent',
        });

        await db.query(
          `INSERT INTO pending_replies
            (client_id, platform, lead_id, lead_name, inbound_message, thread_context, classification, draft_reply, status, sent_reply)
           VALUES ($1, 'sms', $2, $3, $4, $5, 'POSITIVE_FOLLOWUP', $6, 'sent', $6)`,
          [
            clientId,
            phoneDisplay,
            businessName || 'Unknown',
            '(automated follow-up)',
            JSON.stringify({ note: 'auto free-site SMS', phone: phoneDisplay, template: tpl }),
            bodyToSend,
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
    }, delayMs);

    res.status(200).json({ ok: true, intent: 'positive', scheduled: true, delay_ms: delayMs });
  } catch (err) {
    console.error('[Webhook SMS] error', err.message, err.stack);
    res.status(200).json({ ok: true, error: err.message });
  }
});

module.exports = router;
