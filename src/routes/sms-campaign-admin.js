const { Router } = require('express');
const multer = require('multer');
const smsCampaign = require('../services/sms-campaign');
const prospects = require('../services/prospects');
const { listCampaignEvents } = require('../services/campaign-log');
const { parseCsvToLeadRows } = require('../utils/csv-leads');

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  // CSV lead lists can be large (50k+ rows); keep in-memory but allow a bigger cap.
  // If this cap is hit, we return JSON via the error handler below.
  limits: { fileSize: 80 * 1024 * 1024 },
});

const { dashboardSecretOk } = require('../utils/dashboard-secret');

function jsonMulterError(err, _req, res, next) {
  if (!err) return next();
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'CSV too large (max 80MB)' });
  }
  return res.status(400).json({ error: err.message || 'Upload failed' });
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
    const draftMode = !!(req.body && req.body.draft);
    const camp = await smsCampaign.replaceSteps(
      req.params.clientId,
      req.params.campaignId,
      (req.body && req.body.steps) || [],
      { draftMode }
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
router.post('/admin/sms/staged-leads/:clientId/csv', upload.single('file'), jsonMulterError, async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const buf = req.file?.buffer;
    if (!buf || !buf.length) return res.status(400).json({ error: 'file required (multipart field: file)' });
    const { rows, csv_rows } = parseCsvToLeadRows(buf);
    if (!csv_rows) return res.json({ imported: 0, csv_rows: 0, unique_phones_upserted: 0, total_contacts: 0 });

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

/** Replace all contacts for this campaign with CSV contents (same parser as upload). */
router.post('/admin/sms/staged-leads/:clientId/csv-replace', upload.single('file'), jsonMulterError, async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const clientId = req.params.clientId;
    const buf = req.file?.buffer;
    if (!buf || !buf.length) return res.status(400).json({ error: 'file required (multipart field: file)' });
    const deleted = await prospects.deleteAllProspectsForClient(clientId);
    const { rows, csv_rows } = parseCsvToLeadRows(buf);
    if (!csv_rows) {
      const total_contacts = await prospects.countProspects(clientId).catch(() => 0);
      return res.json({
        replaced: true,
        deleted,
        imported: 0,
        csv_rows: 0,
        unique_phones_upserted: 0,
        total_contacts,
      });
    }
    const out = await smsCampaign.importStagedLeads(clientId, rows, req.query.source_label || '');
    res.json({ replaced: true, deleted, ...out });
  } catch (err) {
    console.error('[SMS Campaign] csv replace', err.message);
    res.status(400).json({ error: err.message });
  }
});

/** Delete all sms_prospect rows for this campaign (Supabase). */
router.delete('/admin/sms/prospects/:clientId/all', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const deleted = await prospects.deleteAllProspectsForClient(req.params.clientId);
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error('[SMS Campaign] delete prospects', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Delete every row in sms_prospect (global wipe — table schema unchanged). */
router.delete('/admin/sms/prospects-all', async (req, res) => {
  if (!dashboardSecretOk(req)) {
    return res.status(401).json({ error: 'Missing or invalid x-dashboard-secret' });
  }
  try {
    const deleted = await prospects.deleteAllProspectsGlobally();
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error('[SMS Campaign] delete all prospects', err.message);
    res.status(500).json({ error: err.message });
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
    const clientId = req.params.clientId;
    const total = await prospects.countProspects(clientId);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const rows = await prospects.listProspectsPage(clientId, { limit, offset });
    res.json({
      prospects: rows,
      total,
      limit,
      offset,
      has_more: offset + rows.length < total,
    });
  } catch (err) {
    console.error('[SMS Campaign] prospects list', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ensure upload/multipart errors return JSON (avoid Express default HTML error pages).
// This specifically fixes the dashboard seeing `<!doctype ...>` when a CSV upload fails.
router.use((err, _req, res, next) => {
  if (!err) return next();
  const isMulter = err && (err instanceof multer.MulterError || err.name === 'MulterError');
  if (isMulter) {
    const code = err.code || 'UPLOAD_ERROR';
    const message =
      code === 'LIMIT_FILE_SIZE'
        ? 'CSV too large (max 25MB)'
        : (err.message || 'Upload error');
    return res.status(400).json({ error: message, code });
  }
  return res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
