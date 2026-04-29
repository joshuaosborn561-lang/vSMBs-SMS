const { Router } = require('express');
const db = require('../db');
const slackService = require('../services/slack');
const slackVerify = require('../middleware/slackVerify');
const { sendReplyToPlatform, maybeBookMeetingAfterSend } = require('../services/reply-send');
const prospects = require('../services/prospects');
const gmailEmailLog = require('../services/gmail-email-log');

const router = Router();

router.post('/slack/actions', slackVerify, async (req, res) => {
  let interaction;
  try {
    interaction = JSON.parse(req.body.payload);
  } catch (err) {
    console.error('[Slack] Failed to parse interaction payload', err.message);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Modal submissions must respond within 3s — acknowledge first
  if (interaction.type === 'view_submission' && interaction.view?.callback_id === 'edit_reply_modal') {
    res.status(200).json({ response_action: 'clear' });
    try {
      await handleEditModalSubmit(interaction);
    } catch (err) {
      console.error('[Slack] Edit modal submit error', { err: err.message, stack: err.stack });
    }
    return;
  }

  if (interaction.type === 'view_submission' && interaction.view?.callback_id === 'sms_reply_modal') {
    res.status(200).json({ response_action: 'clear' });
    try {
      await handleSmsReplyModalSubmit(interaction);
    } catch (err) {
      console.error('[Slack] SMS reply modal submit error', { err: err.message, stack: err.stack });
    }
    return;
  }

  res.status(200).send();

  try {
    const action = interaction.actions?.[0];
    if (!action) return;

    console.log('[Slack] Action received', { actionId: action.action_id, value: action.value });

    if (action.action_id === 'approve_reply') {
      await handleApprove(action.value, interaction);
    } else if (action.action_id === 'reject_reply') {
      await handleReject(action.value, interaction);
    } else if (action.action_id === 'open_edit_modal') {
      await handleOpenEditModal(action.value, interaction);
    } else if (action.action_id === 'sms_escalation_reply') {
      await handleSmsEscalationReply(action.value, interaction);
    } else if (action.action_id === 'sms_escalation_dnc') {
      await handleSmsEscalationDnc(action.value, interaction);
    } else if (action.action_id === 'sms_followup_send_site') {
      await handleSmsFollowupSendSite(action.value, interaction);
    } else if (action.action_id === 'sms_followup_dnc') {
      await handleSmsFollowupDnc(action.value, interaction);
    } else if (action.action_id === 'gmail_mark_done') {
      await handleGmailMarkDone(action.value, interaction);
    }
  } catch (err) {
    console.error('[Slack] Action handler error', { err: err.message, stack: err.stack });
  }
});

async function handleOpenEditModal(replyId, interaction) {
  const { rows: [reply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1 AND status = $2', [replyId, 'pending']);
  if (!reply) {
    console.warn('[Slack] open_edit_modal: reply not pending', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  await slackService.openEditReplyModal(client.slack_bot_token, interaction.trigger_id, {
    replyId,
    initialDraft: reply.draft_reply || '',
    channelId: interaction.channel?.id,
    messageTs: interaction.message?.ts,
  });
}

async function handleEditModalSubmit(interaction) {
  let meta;
  try {
    meta = JSON.parse(interaction.view.private_metadata || '{}');
  } catch {
    meta = {};
  }
  const replyId = meta.replyId;
  const channelId = meta.channelId;
  const messageTs = meta.messageTs;
  if (!replyId) return;

  const draftState = interaction.view.state.values?.draft_block?.draft_input;
  const messageText = (draftState?.value || '').trim();
  if (!messageText) return;

  const { rows: [reply] } = await db.query(
    'UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING *',
    ['approved', replyId, 'pending']
  );

  if (!reply) {
    console.warn('[Slack] Edit submit: reply not found or already actioned', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);

  try {
    await sendReplyToPlatform(client, reply, messageText);

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, draft_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', messageText, replyId]
    );

    let statusMsg = `✅ Reply to ${reply.lead_name} edited and sent by <@${interaction.user.id}>.`;
    statusMsg += await maybeBookMeetingAfterSend({ ...reply, draft_reply: messageText, lead_email: reply.lead_email }, client);

    if (channelId && messageTs) {
      await slackService.updateMessage(
        client.slack_bot_token, channelId, messageTs,
        statusMsg
      );
    }
  } catch (err) {
    console.error('[Slack] Edit modal send failed', { replyId, err: err.message });
    await db.query('UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2', ['flagged', replyId]);
    if (channelId && messageTs) {
      await slackService.updateMessage(
        client.slack_bot_token, channelId, messageTs,
        `⚠️ Reply to ${reply.lead_name} was edited but failed to send: ${err.message}. Please reply manually.`
      );
    }
  }
}

async function handleApprove(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    'UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING *',
    ['approved', replyId, 'pending']
  );

  if (!reply) {
    console.warn('[Slack] Reply not found or already actioned', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);

  try {
    await sendReplyToPlatform(client, reply, reply.draft_reply);

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', reply.draft_reply, replyId]
    );

    let statusMsg = `✅ Reply to ${reply.lead_name} approved and sent by <@${interaction.user.id}>.`;
    statusMsg += await maybeBookMeetingAfterSend(reply, client);

    await slackService.updateMessage(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      statusMsg
    );

    console.log('[Slack] Reply approved and sent', { replyId, platform: reply.platform, lead: reply.lead_name });
  } catch (err) {
    console.error('[Slack] Failed to send reply after approval', { replyId, err: err.message });
    await db.query('UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2', ['flagged', replyId]);
    await slackService.updateMessage(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      `⚠️ Reply to ${reply.lead_name} was approved but failed to send: ${err.message}. Please reply manually.`
    );
  }
}

function parseJsonSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

async function handleSmsEscalationReply(valueJson, interaction) {
  const meta = parseJsonSafe(valueJson);
  const { replyId, phone } = meta;
  if (!replyId) return;

  const { rows: [reply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
  if (!reply) return;

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  await slackService.openSmsReplyModal(client.slack_bot_token, interaction.trigger_id, {
    replyId,
    phone: phone || reply.lead_id,
    channelId: interaction.channel?.id,
    messageTs: interaction.message?.ts,
  });
}

async function handleSmsEscalationDnc(valueJson, interaction) {
  const meta = parseJsonSafe(valueJson);
  const { replyId, phone } = meta;
  const { rows: [reply] } = await db.query(
    'UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING *',
    ['rejected', replyId, 'pending']
  );
  if (!reply) return;

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  const p = phone || reply.lead_id;

  try {
    await prospects.appendDnc(client.id, p, 'slack_escalation_dnc');
    await prospects.patchProspectFields(client.id, p, {
      dnc: true,
      customer_status: 'dnc',
      intent: 'human_dnc',
    });
  } catch (e) {
    console.error('[Slack] DNC prospect update failed', e.message);
  }

  await slackService.updateMessage(
    client.slack_bot_token,
    interaction.channel.id,
    interaction.message.ts,
    `🚫 Marked DNC for *${p}* by <@${interaction.user.id}>.`
  );
}

async function handleSmsFollowupSendSite(valueJson, interaction) {
  const meta = parseJsonSafe(valueJson);
  const { replyId, phone } = meta;
  const { rows: [reply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
  if (!reply) return;

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  const p = phone || reply.lead_id;

  try {
    await prospects.patchProspectFields(client.id, p, {
      customer_status: 'send_site_acknowledged',
    });
  } catch (e) {
    console.error('[Slack] Prospect update failed', e.message);
  }

  await slackService.updateMessage(
    client.slack_bot_token,
    interaction.channel.id,
    interaction.message.ts,
    `✅ *Send Site* noted for *${p}* by <@${interaction.user.id}> — send the site manually when ready.`
  );
}

async function handleSmsFollowupDnc(valueJson, interaction) {
  const meta = parseJsonSafe(valueJson);
  const { replyId, phone: metaPhone } = meta;
  const { rows: [reply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
  if (!reply) return;

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  const p = metaPhone || reply.lead_id;

  try {
    await prospects.appendDnc(client.id, p, 'slack_followup_dnc');
    await prospects.patchProspectFields(client.id, p, {
      dnc: true,
      customer_status: 'dnc',
      intent: 'human_dnc',
    });
  } catch (e) {
    console.error('[Slack] Follow-up DNC prospect failed', e.message);
  }

  await slackService.updateMessage(
    client.slack_bot_token,
    interaction.channel.id,
    interaction.message.ts,
    `🚫 Marked DNC for *${p}* (follow-up) by <@${interaction.user.id}>.`
  );
}

async function handleGmailMarkDone(valueJson, interaction) {
  const meta = parseJsonSafe(valueJson);
  const notificationId = meta.notificationId;
  if (!notificationId) return;

  const { rows: [notif] } = await db.query(
    `UPDATE gmail_notifications SET handled_at = now() WHERE id = $1 AND handled_at IS NULL RETURNING *`,
    [notificationId]
  );
  if (!notif) return;

  if (notif.gmail_message_id) {
    await gmailEmailLog.markHandled(notif.client_id, notif.gmail_message_id);
  }

  await slackService.updateMessage(
    client.slack_bot_token,
    interaction.channel.id,
    interaction.message.ts,
    `✅ Email marked done by <@${interaction.user.id}>.`
  );
}

async function handleSmsReplyModalSubmit(interaction) {
  let meta;
  try {
    meta = JSON.parse(interaction.view.private_metadata || '{}');
  } catch {
    meta = {};
  }
  const replyId = meta.replyId;
  const channelId = meta.channelId;
  const messageTs = meta.messageTs;
  const phone = meta.phone;

  const bodyState = interaction.view.state.values?.sms_body_block?.sms_body_input;
  const messageText = (bodyState?.value || '').trim();
  if (!replyId || !messageText) return;

  const { rows: [reply] } = await db.query(
    'UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING *',
    ['approved', replyId, 'pending']
  );
  if (!reply) return;

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);

  try {
    const toSend = { ...reply, lead_id: phone || reply.lead_id };
    await sendReplyToPlatform(client, toSend, messageText);

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', messageText, replyId]
    );

    try {
      await prospects.patchProspectFields(client.id, phone || reply.lead_id, {
        reply: messageText,
        customer_status: 'manual_sms_sent',
      });
    } catch (e) {
      console.error('[Slack] Prospect log failed after SMS', e.message);
    }

    if (channelId && messageTs) {
      await slackService.updateMessage(
        client.slack_bot_token,
        channelId,
        messageTs,
        `✅ SMS sent to *${phone || reply.lead_id}* by <@${interaction.user.id}>.`
      );
    }
  } catch (err) {
    console.error('[Slack] SMS send failed', err.message);
    await db.query('UPDATE pending_replies SET status = $1 WHERE id = $2', ['flagged', replyId]);
  }
}

async function handleReject(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    'UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING *',
    ['rejected', replyId, 'pending']
  );

  if (!reply) return;

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);

  await slackService.updateMessage(
    client.slack_bot_token, interaction.channel.id, interaction.message.ts,
    `❌ Reply to ${reply.lead_name} rejected by <@${interaction.user.id}>.`
  );

  console.log('[Slack] Reply rejected', { replyId, lead: reply.lead_name });
}

module.exports = router;
