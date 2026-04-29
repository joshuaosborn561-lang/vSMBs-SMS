const { getSupabase } = require('./supabase-client');

/** Table: gmail_inbound_email (create manually in Supabase — see supabase/schema-reference.sql) */
async function insertInboundEmail(clientId, row) {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from('gmail_inbound_email').insert({
    client_id: clientId,
    gmail_message_id: row.gmail_message_id,
    sender_email: row.sender_email || null,
    sender_name: row.sender_name || null,
    subject: row.subject || null,
    body_preview: row.body_preview || null,
    status: 'pending',
  });
  if (error && !String(error.message || '').includes('duplicate')) {
    console.warn('[GmailEmailLog]', error.message);
  }
}

async function markHandled(clientId, gmailMessageId) {
  const sb = getSupabase();
  if (!sb) return;
  await sb
    .from('gmail_inbound_email')
    .update({
      status: 'handled',
      handled_at: new Date().toISOString(),
    })
    .eq('client_id', clientId)
    .eq('gmail_message_id', gmailMessageId);
}

module.exports = { insertInboundEmail, markHandled };
