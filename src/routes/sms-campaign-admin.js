const { Router } = require('express');
const multer = require('multer');
const smsCampaign = require('../services/sms-campaign');
const prospects = require('../services/prospects');
const { listCampaignEvents } = require('../services/campaign-log');

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const { dashboardSecretOk } = require('../utils/dashboard-secret');

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
    const body = { ...(req.body || {}) };
    [
      'max_sends_per_day',
      'max_new_enrollments_per_day',
      'min_gap_between_sends_ms',
    ].forEach((k) => {
      if (body[k] === '' || body[k] === null) body[k] = null;
      else if (body[k] !== undefined) {
        const n = parseInt(body[k], 10);
        body[k] = Number.isFinite(n) ? n : null;
      }
    });
    const camp = await smsCampaign.updateCampaign(
      req.params.clientId,
      req.params.campaignId,
      body
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

router.get('/admin/sms/transitions/:clientId', async (req, res) => {
  try {
    const transitions = await smsCampaign.listTransitions(req.params.clientId);
    res.json({ transitions });
  } catch (err) {
    console.error('[SMS Campaign] transitions list', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/sms/transition/:clientId', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    await smsCampaign.upsertTransition(req.params.clientId, req.body || {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[SMS Campaign] transition upsert', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.delete('/admin/sms/transition/:clientId/:sourceCampaignId/:triggerIntent', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    await smsCampaign.deleteTransition(
      req.params.clientId,
      req.params.sourceCampaignId,
      req.params.triggerIntent
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[SMS Campaign] transition delete', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** CSV upload → staged leads (phone column required); merges extra columns into variables */
router.post('/admin/sms/staged-leads/:clientId/csv', upload.single('file'), async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const buf = req.file?.buffer;
    if (!buf || !buf.length) return res.status(400).json({ error: 'file required (multipart field: file)' });
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return res.json({ imported: 0 });

    const rawHeader = lines[0].split(',').map((s) => s.trim().replace(/^"|"$/g, '').toLowerCase());
    const hasHeader = rawHeader.some((h) => h === 'phone' || h === 'phone_number' || h === 'mobile');
    const headerRow = hasHeader ? rawHeader : null;
    const dataLines = hasHeader ? lines.slice(1) : lines;

    const normKey = (k) => String(k || '').trim().toLowerCase().replace(/\s+/g, '_');

    const rows = [];
    for (const line of dataLines) {
      const cells = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) {
          cells.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      cells.push(cur.trim());

      let phoneIdx = 0;
      if (headerRow) {
        phoneIdx = headerRow.findIndex((h) => h === 'phone' || h === 'phone_number' || h === 'mobile');
        if (phoneIdx < 0) phoneIdx = 0;
      }
      const phone = cells[phoneIdx] ? cells[phoneIdx].replace(/^"|"$/g, '').trim() : '';
      if (!phone) continue;

      const obj = { phone };
      if (headerRow) {
        headerRow.forEach((h, i) => {
          if (i === phoneIdx) return;
          const k = normKey(h);
          if (!k) return;
          if (cells[i] != null && cells[i] !== '') obj[k] = cells[i].replace(/^"|"$/g, '').trim();
        });
      }
      rows.push(obj);
    }

    const out = await smsCampaign.importStagedLeads(
      req.params.clientId,
      rows,
      req.query.source_label || ''
    );
    res.json(out);
  } catch (err) {
    console.error('[SMS Campaign] csv import', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/sms/staged-leads/:clientId', async (req, res) => {
  try {
    const rows = await smsCampaign.listStagedLeads(req.params.clientId, req.query.limit);
    res.json({ leads: rows });
  } catch (err) {
    console.error('[SMS Campaign] staged list', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/sms/campaign-events/:clientId', async (req, res) => {
  try {
    const limit = req.query.limit;
    const events = await listCampaignEvents(req.params.clientId, limit);
    res.json({ events });
  } catch (err) {
    console.error('[SMS Campaign] events', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/sms/prospects/:clientId', async (req, res) => {
  try {
    const rows = await prospects.listProspects(req.params.clientId, req.query.limit);
    res.json({ prospects: rows });
  } catch (err) {
    console.error('[SMS Campaign] prospects list', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
