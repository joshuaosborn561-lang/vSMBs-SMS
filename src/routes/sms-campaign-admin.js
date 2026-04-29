const { Router } = require('express');
const smsCampaign = require('../services/sms-campaign');

const router = Router();

function dashboardSecretOk(req) {
  const secret = (process.env.DASHBOARD_ACTION_SECRET || process.env.WEBHOOK_TEST_SECRET || '').trim();
  if (!secret) return false;
  const got = (req.headers['x-dashboard-secret'] || req.headers['x-webhook-test-secret'] || '').trim();
  return got === secret;
}

/** GET /admin/sms/campaigns/:clientId */
router.get('/admin/sms/campaigns/:clientId', async (req, res) => {
  try {
    const items = await smsCampaign.listCampaigns(req.params.clientId);
    res.json({ campaigns: items });
  } catch (err) {
    console.error('[SMS Campaign] list', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/sms/campaign/:clientId/:campaignId */
router.get('/admin/sms/campaign/:clientId/:campaignId', async (req, res) => {
  try {
    const camp = await smsCampaign.getCampaignWithSteps(req.params.campaignId, req.params.clientId);
    if (!camp) return res.status(404).json({ error: 'Campaign not found' });
    res.json(camp);
  } catch (err) {
    console.error('[SMS Campaign] get', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/sms/campaign/:clientId  body: { name } */
router.post('/admin/sms/campaign/:clientId', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const row = await smsCampaign.createCampaign(req.params.clientId, req.body || {});
    res.json(row);
  } catch (err) {
    console.error('[SMS Campaign] create', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /admin/sms/campaign/:clientId/:campaignId */
router.patch('/admin/sms/campaign/:clientId/:campaignId', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const camp = await smsCampaign.updateCampaign(
      req.params.clientId,
      req.params.campaignId,
      req.body || {}
    );
    if (!camp) return res.status(404).json({ error: 'Campaign not found' });
    res.json(camp);
  } catch (err) {
    console.error('[SMS Campaign] patch', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** PUT /admin/sms/campaign/:clientId/:campaignId/steps  body: { steps: [{ body_template, delay_after_ms }] } */
router.put('/admin/sms/campaign/:clientId/:campaignId/steps', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const camp = await smsCampaign.replaceSteps(
      req.params.clientId,
      req.params.campaignId,
      (req.body && req.body.steps) || []
    );
    res.json(camp);
  } catch (err) {
    console.error('[SMS Campaign] steps', err.message);
    res.status(400).json({ error: err.message });
  }
});

/** POST /admin/sms/campaign/:clientId/:campaignId/preview  body: { phones: string[] } */
router.post('/admin/sms/campaign/:clientId/:campaignId/preview', async (req, res) => {
  try {
    const phones = (req.body && req.body.phones) || [];
    const out = await smsCampaign.previewSteps(req.params.clientId, req.params.campaignId, phones);
    res.json(out);
  } catch (err) {
    console.error('[SMS Campaign] preview', err.message);
    res.status(400).json({ error: err.message });
  }
});

/** POST /admin/sms/campaign/:clientId/:campaignId/enroll  body: { phones: string[] } — queues step 1 */
router.post('/admin/sms/campaign/:clientId/:campaignId/enroll', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const phones = (req.body && req.body.phones) || [];
    const summary = await smsCampaign.enrollLeads(
      req.params.clientId,
      req.params.campaignId,
      phones
    );
    res.json(summary);
  } catch (err) {
    console.error('[SMS Campaign] enroll', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/sms/campaign/:clientId/:campaignId/enrollments', async (req, res) => {
  try {
    const limit = req.query.limit;
    const rows = await smsCampaign.listEnrollments(
      req.params.clientId,
      req.params.campaignId,
      limit
    );
    res.json({ enrollments: rows });
  } catch (err) {
    console.error('[SMS Campaign] enrollments', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/sms/campaign/:clientId/:campaignId/jobs', async (req, res) => {
  try {
    const limit = req.query.limit;
    const rows = await smsCampaign.listJobs(req.params.clientId, req.params.campaignId, limit);
    res.json({ jobs: rows });
  } catch (err) {
    console.error('[SMS Campaign] jobs', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
