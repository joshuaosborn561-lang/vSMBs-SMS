const { Router } = require('express');
const db = require('../db');
const prospects = require('../services/prospects');
const { renderSmsTemplate } = require('../utils/sms-template');
const smsLog = require('../services/sms-log');

const router = Router();

const DEFAULT_FREE_SITE = "I actually made you a site for free — want me to send it to you?";

const { dashboardSecretOk } = require('../utils/dashboard-secret');
const { listGatewayMobiles } = require('../services/sms-gateway');

/** GET /admin/sms/gateway/mobiles — SMSMobileAPI connected devices (uses server SMSMOBILEAPI_KEY) */
router.get('/admin/sms/gateway/mobiles', async (req, res) => {
  try {
    const sid = req.query.sid ? String(req.query.sid) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const data = await listGatewayMobiles({ sid, search });
    res.json(data);
  } catch (err) {
    console.error('[SMS Dashboard] gateway mobiles', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/sms/log — master inbox (all campaigns), newest first */
router.get('/admin/sms/log', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 80));
    const rows = await smsLog.listLogMaster(limit);
    res.json({ items: rows });
  } catch (err) {
    console.error('[SMS Dashboard] master log', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
 * Variables from sms_prospect in Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
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
    return res.status(401).json({
      error:
        'Missing or invalid x-dashboard-secret — set DASHBOARD_ACTION_SECRET on the server if you want to lock dashboard SMS actions',
    });
  }
  try {
    const { clientId } = req.params;
    const phone = String(req.body?.phone || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!phone || !body) return res.status(400).json({ error: 'phone and body required' });

    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { sendSms } = require('../services/sms-gateway');
    const gw = await smsLog.getSmsGatewayOptionsForClient(clientId);
    let port = gw.port;
    if (req.body?.port === 1 || req.body?.port === 2) port = req.body.port;
    let sIdentifiant = gw.sIdentifiant;
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'sIdentifiant')) {
      const s = String(req.body.sIdentifiant || '').trim();
      sIdentifiant = s || undefined;
    }
    const result = await sendSms({ to: phone, body, port, sIdentifiant });
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
