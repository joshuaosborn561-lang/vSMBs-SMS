const { WebClient } = require('@slack/web-api');

// Cache WebClient instances per token
const clientCache = new Map();

function getClient(token) {
  if (!clientCache.has(token)) {
    clientCache.set(token, new WebClient(token));
  }
  return clientCache.get(token);
}

async function postDraftApproval(token, channelId, { replyId, leadName, leadEmail, platform, classification, draft, reasoning, inboundMessage }) {
  const slack = getClient(token);

  return slack.chat.postMessage({
    channel: channelId,
    text: `New ${platform} reply from ${leadName} — ${classification}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📩 ${platform.toUpperCase()} Reply — ${classification}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*From:* ${leadName}${leadEmail ? ` (${leadEmail})` : ''}\n*Classification:* ${classification}\n*Reasoning:* ${reasoning}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Their message:*\n>${inboundMessage.split('\n').join('\n>')}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Draft reply:*\n${draft}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve & Send' },
            style: 'primary',
            action_id: 'approve_reply',
            value: replyId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Edit & send' },
            action_id: 'open_edit_modal',
            value: replyId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Reject' },
            style: 'danger',
            action_id: 'reject_reply',
            value: replyId,
          },
        ],
      },
    ],
  });
}

async function postAlert(token, channelId, { leadName, platform, classification, inboundMessage, reasoning }) {
  const slack = getClient(token);

  return slack.chat.postMessage({
    channel: channelId,
    text: `${platform.toUpperCase()} alert: ${classification} from ${leadName}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🔔 ${classification} — ${platform.toUpperCase()}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*From:* ${leadName}\n*Classification:* ${classification}\n*Reasoning:* ${reasoning}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Their message:*\n>${inboundMessage.split('\n').join('\n>')}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'ℹ️ No draft generated — alert only.' }],
      },
    ],
  });
}

async function postError(token, channelId, { leadName, platform, error }) {
  const slack = getClient(token);

  return slack.chat.postMessage({
    channel: channelId,
    text: `⚠️ Draft generation failed for ${leadName} (${platform}). Please reply manually. Error: ${error}`,
  });
}

async function postReminder(token, channelId, messageTs, { replyId, leadName, minutes, escalate }) {
  const slack = getClient(token);

  const text = escalate
    ? `<!here> 🚨 Reply to *${leadName}* has been pending for ${minutes} minutes. Please take action now.`
    : `⏰ Reminder: Reply to *${leadName}* has been pending for ${minutes} minutes.`;

  return slack.chat.postMessage({
    channel: channelId,
    thread_ts: messageTs,
    text,
  });
}

async function updateMessage(token, channelId, messageTs, text) {
  const slack = getClient(token);

  return slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks: [],
  });
}

async function postSmsEscalation(token, channelId, { replyId, phone, businessName, vertical, city, intent, inboundMessage, reasoning }) {
  const slack = getClient(token);
  const meta = JSON.stringify({ replyId, phone });
  return slack.chat.postMessage({
    channel: channelId,
    text: `SMS needs attention: ${phone} — ${intent}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📱 SMS — ${intent}` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Phone:* ${phone}\n*Business:* ${businessName || '—'}\n*Vertical:* ${vertical || '—'}\n*City:* ${city || '—'}\n*Reasoning:* ${reasoning || '—'}`,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Their message:*\n>${String(inboundMessage).split('\n').join('\n>')}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reply' },
            style: 'primary',
            action_id: 'sms_escalation_reply',
            value: meta.slice(0, 2000),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Mark DNC' },
            style: 'danger',
            action_id: 'sms_escalation_dnc',
            value: meta.slice(0, 2000),
          },
        ],
      },
    ],
  });
}

async function postSmsFollowupAlert(token, channelId, payload) {
  const slack = getClient(token);
  const meta = JSON.stringify({
    replyId: payload.replyId,
    phone: payload.phone,
    businessName: payload.businessName,
    vertical: payload.vertical,
    city: payload.city,
  });
  return slack.chat.postMessage({
    channel: channelId,
    text: `Free site interest: ${payload.businessName || payload.phone}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🏗️ Free site — affirmative reply' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Business:* ${payload.businessName || '—'}\n*Phone:* ${payload.phone}\n*City:* ${payload.city || '—'}\n*Vertical:* ${payload.vertical || '—'}`,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Their message:*\n>${String(payload.inboundMessage).split('\n').join('\n>')}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Send Site' },
            style: 'primary',
            action_id: 'sms_followup_send_site',
            value: meta.slice(0, 2000),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Mark DNC' },
            style: 'danger',
            action_id: 'sms_followup_dnc',
            value: meta.slice(0, 2000),
          },
        ],
      },
    ],
  });
}

async function postSmsAutomationFailed(token, channelId, { phone, businessName, error }) {
  const slack = getClient(token);
  return slack.chat.postMessage({
    channel: channelId,
    text: `SMS auto follow-up failed for ${phone}: ${error}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '⚠️ SMS send failed' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Phone:* ${phone}\n*Business:* ${businessName || '—'}\n*Error:* ${String(error).slice(0, 500)}`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'The free-site prompt was not delivered. Fix gateway config or send manually.' }],
      },
    ],
  });
}

async function postGmailInbound(token, channelId, { notificationId, senderName, senderEmail, subject, body }) {
  const slack = getClient(token);
  const meta = JSON.stringify({ notificationId });
  const bodyText = String(body || '').slice(0, 2800);
  return slack.chat.postMessage({
    channel: channelId,
    text: `Email from ${senderEmail}: ${subject}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📧 Inbound email (websites@)' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*From:* ${senderName || '—'} <${senderEmail}>\n*Subject:* ${subject}`,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Body:*\n${bodyText}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Mark Done' },
            style: 'primary',
            action_id: 'gmail_mark_done',
            value: meta.slice(0, 2000),
          },
        ],
      },
    ],
  });
}

async function openEditReplyModal(token, triggerId, { replyId, initialDraft, channelId, messageTs }) {
  const slack = getClient(token);
  const meta = JSON.stringify({ replyId, channelId, messageTs });

  return slack.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'edit_reply_modal',
      private_metadata: meta,
      title: { type: 'plain_text', text: 'Edit reply' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'draft_block',
          label: { type: 'plain_text', text: 'Message to send to the prospect' },
          element: {
            type: 'plain_text_input',
            action_id: 'draft_input',
            multiline: true,
            ...((initialDraft && String(initialDraft).trim())
              ? { initial_value: String(initialDraft).slice(0, 2900) }
              : {}),
          },
        },
      ],
    },
  });
}

async function openSmsReplyModal(token, triggerId, { replyId, phone, channelId, messageTs }) {
  const slack = getClient(token);
  const meta = JSON.stringify({ replyId, phone, channelId, messageTs });

  return slack.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'sms_reply_modal',
      private_metadata: meta,
      title: { type: 'plain_text', text: 'SMS reply' },
      submit: { type: 'plain_text', text: 'Send SMS' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'sms_body_block',
          label: { type: 'plain_text', text: 'Message' },
          element: {
            type: 'plain_text_input',
            action_id: 'sms_body_input',
            multiline: true,
          },
        },
      ],
    },
  });
}

module.exports = {
  postDraftApproval,
  postAlert,
  postError,
  postReminder,
  updateMessage,
  openEditReplyModal,
  postSmsEscalation,
  postSmsFollowupAlert,
  postGmailInbound,
  postSmsAutomationFailed,
  openSmsReplyModal,
};
