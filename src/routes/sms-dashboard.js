const { Router } = require('express');
const db = require('../db');
const prospects = require('../services/prospects');
const { renderSmsTemplate } = require('../utils/sms-template');
const smsLog = require('../services/sms-log');

const router = Router();

const DEFAULT_FREE_SITE = "I actually made you a site for free — want me to send it to you?";

function dashboardSecretOk(req) {
  const secret = (process.env.DASHBOARD_ACTION_SECRET || process.env.WEBHOOK_TEST_SECRET || '').trim();
  if (!secret) return false;
  const got = (req.headers['x-dashboard-secret'] || req.headers['x-webhook-test-secret'] || '').trim();
  return got === secret;
}

/** GET /admin/sms/log/:clientId — timeline of SMS in/out with delays */
router.get('/admin/sms/log/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const { rows: [client] } = await db.query('SELECT id FROM clients WHERE id = $1', [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const rows = await smsLog.listLog(clientId, limit);
    res.json({ items: rows });
  } catch (err) {
    console.error('[SMS Dashboard] log', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/sms/preview/:clientId?phone=+1...
 * Variables from Supabase sms_prospect (requires SUPABASE_* env).
 */
router.get('/admin/sms/preview/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const phone = String(req.query.phone || '').trim();
    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!phone) return res.status(400).json({ error: 'phone query param required' });

    const template = (client.sms_free_site_body && String(client.sms_free_site_body).trim())
      || DEFAULT_FREE_SITE;
    const delayMs = client.sms_free_site_delay_ms != null ? Number(client.sms_free_site_delay_ms) : 20000;

    const { row } = await prospects.findProspectByPhone(clientId, phone);
    const variables = row ? prospects.prospectRowToVariables(row) : { phone };
    const rendered = renderSmsTemplate(template, variables);

    res.json({
      phone,
      matched: !!row,
      prospect_id: row?.id || null,
      template,
      delay_ms: delayMs,
      variables,
      rendered,
    });
  } catch (err) {
    console.error('[SMS Dashboard] preview', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/sms/test-send/:clientId — send one SMS (requires secret header) */
router.post('/admin/sms/test-send/:clientId', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret (set WEBHOOK_TEST_SECRET or DASHBOARD_ACTION_SECRET)' });
  }
  try {
    const { clientId } = req.params;
    const phone = String(req.body?.phone || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!phone || !body) return res.status(400).json({ error: 'phone and body required' });

    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { sendSms } = require('../services/sms-gateway');
    const result = await sendSms({ to: phone, body });
    await smsLog.logOutboundSent({
      clientId,
      leadPhone: phone,
      body,
      templateKey: 'manual_test',
      variables: { source: 'dashboard_test_send' },
      providerMessageId: result.id,
    });
    res.json({ ok: true, provider: result });
  } catch (err) {
    console.error('[SMS Dashboard] test-send', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
