/**
 * Unified campaign API for the SmartLead-style flow.
 *
 * One "campaign" = one `clients` workspace + its primary `sms_campaign` sequence.
 * Endpoints:
 *  - GET    /admin/campaigns                              list (with derived status + counts)
 *  - GET    /admin/campaigns/:clientId                    full snapshot (workspace + primary sequence + steps + counts)
 *  - POST   /admin/campaigns                              create draft (workspace + default sequence + 1 placeholder step)
 *  - PATCH  /admin/campaigns/:clientId                    atomic save (workspace + sequence meta + steps)
 *  - POST   /admin/campaigns/:clientId/launch             validate + enroll staged leads + go live
 *  - POST   /admin/campaigns/:clientId/pause              pause sends
 *  - POST   /admin/campaigns/:clientId/resume             resume sends
 *  - DELETE /admin/campaigns/:clientId                    archive (soft-delete)
 *  - GET    /admin/campaigns/:clientId/variables          merged variable suggestions for the inserter
 */
const { Router } = require('express');
const db = require('../db');
const smsLog = require('../services/sms-log');
const smsCampaign = require('../services/sms-campaign');
const prospects = require('../services/prospects');

const router = Router();

function webhookUrl(clientId) {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + (process.env.PORT || 3000);
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return `${protocol}://${domain}/webhook/sms/${clientId}`;
}

function deriveStatus(client, sequence, stagedCount) {
  if (!client) return 'archived';
  if (client.archived_at) return 'archived';
  const seqStatus = sequence?.status || (sequence?.active ? 'active' : 'paused');
  const hasStepBody = (sequence?.steps || []).some(
    (s) => String(s.body_template || '').trim() && !/^\(Draft —/.test(String(s.body_template || '').trim())
  );
  const hasLeads = (stagedCount || 0) > 0;
  if (seqStatus === 'active' && client.active) return 'live';
  if (seqStatus === 'paused') return 'paused';
  if (hasStepBody && hasLeads) return 'ready';
  return 'draft';
}

async function getPrimarySequence(clientId) {
  const { rows } = await db.query(
    `SELECT * FROM sms_campaign WHERE client_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

async function ensurePrimarySequence(clientId, name) {
  const existing = await getPrimarySequence(clientId);
  if (existing) return existing;
  const seqName = String(name || 'Default sequence').trim() || 'Default sequence';
  const { rows: [row] } = await db.query(
    `INSERT INTO sms_campaign (client_id, name, active, status)
     VALUES ($1, $2, false, 'draft') RETURNING *`,
    [clientId, seqName]
  );
  await db.query(
    `INSERT INTO sms_campaign_step (campaign_id, sort_order, body_template, delay_after_ms)
     VALUES ($1, 1, $2, 86400000)`,
    [row.id, '(Draft — write your first SMS for {{business_name}})']
  );
  return row;
}

async function loadFullCampaign(clientId) {
  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!client) return null;
  const sequence = await getPrimarySequence(clientId);
  let withSteps = null;
  if (sequence) {
    withSteps = await smsCampaign.getCampaignWithSteps(sequence.id, clientId);
  }
  // Leads live in Supabase sms_prospect (this app no longer uses the staged-leads table as the primary source)
  const stagedCount = await prospects.countProspects(clientId).catch(() => 0);
  let activeEnrollments = 0;
  let pendingJobs = 0;
  if (sequence) {
    const r1 = await db.query(
      `SELECT COUNT(*)::int AS count FROM sms_campaign_enrollment
       WHERE campaign_id = $1 AND status = 'active'`,
      [sequence.id]
    );
    activeEnrollments = r1.rows[0].count;
    const r2 = await db.query(
      `SELECT COUNT(*)::int AS count FROM sms_campaign_job_queue
       WHERE campaign_id = $1 AND status = 'pending'`,
      [sequence.id]
    );
    pendingJobs = r2.rows[0].count;
  }

  const status = deriveStatus(client, withSteps, stagedCount);

  return {
    id: client.id,
    name: client.name,
    status,
    active: !!client.active,
    archived_at: client.archived_at || null,
    created_at: client.created_at,
    updated_at: client.updated_at,
    slack_bot_token: client.slack_bot_token,
    slack_channel_id: client.slack_channel_id,
    sms_free_site_body: client.sms_free_site_body,
    sms_free_site_delay_ms: client.sms_free_site_delay_ms,
    sms_min_gap_between_texts_ms: client.sms_min_gap_between_texts_ms,
    sms_gateway_port: Number(client.sms_gateway_port) === 1 ? 1 : 2,
    sms_gateway_device_sid: client.sms_gateway_device_sid || null,
    sms_webhook_url: webhookUrl(client.id),
    counts: {
      staged_leads: stagedCount || 0,
      active_enrollments: activeEnrollments,
      pending_jobs: pendingJobs,
    },
    sequence: withSteps
      ? {
          id: withSteps.id,
          name: withSteps.name,
          status: withSteps.status,
          active: !!withSteps.active,
          timezone: withSteps.timezone,
          schedule_days: withSteps.schedule_days,
          schedule_start: withSteps.schedule_start,
          schedule_end: withSteps.schedule_end,
          min_gap_between_sends_ms: withSteps.min_gap_between_sends_ms,
          max_sends_per_day: withSteps.max_sends_per_day,
          max_new_enrollments_per_day: withSteps.max_new_enrollments_per_day,
          exclude_other_campaigns: withSteps.exclude_other_campaigns,
          steps: (withSteps.steps || []).map((s) => ({
            sort_order: s.sort_order,
            body_template: s.body_template,
            delay_after_ms: s.delay_after_ms,
          })),
        }
      : null,
  };
}

const ALLOWED_CLIENT_FIELDS = [
  'name',
  'slack_bot_token',
  'slack_channel_id',
  'sms_free_site_body',
  'sms_free_site_delay_ms',
  'sms_min_gap_between_texts_ms',
  'sms_gateway_port',
  'sms_gateway_device_sid',
];

function applyClientPatch(input) {
  const updates = [];
  const values = [];
  let idx = 1;
  for (const key of ALLOWED_CLIENT_FIELDS) {
    if (input[key] === undefined) continue;
    let v = input[key];
    if ((key === 'slack_bot_token' || key === 'slack_channel_id') && (v === '' || v == null)) v = null;
    if (key === 'sms_min_gap_between_texts_ms') v = Math.max(0, Number(v) || 0);
    if (key === 'sms_free_site_delay_ms') v = Math.max(0, Number(v) || 20000);
    if (key === 'sms_free_site_body' && (v === '' || v == null)) v = null;
    if (key === 'sms_gateway_port') {
      const p = Number(v);
      v = p === 1 ? 1 : 2;
    }
    if (key === 'sms_gateway_device_sid') {
      const s = String(v || '').trim();
      v = s || null;
    }
    if (key === 'name') {
      v = String(v || '').trim();
      if (!v) continue;
    }
    updates.push(`${key} = $${idx}`);
    values.push(v);
    idx += 1;
  }
  return { updates, values };
}

router.get('/admin/campaigns', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id FROM clients
       WHERE archived_at IS NULL
       ORDER BY created_at DESC`
    );
    const out = [];
    for (const row of rows) {
      const full = await loadFullCampaign(row.id);
      if (full) out.push(full);
    }
    res.json({ campaigns: out });
  } catch (err) {
    console.error('[Campaigns] list', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/campaigns/:clientId', async (req, res) => {
  try {
    const full = await loadFullCampaign(req.params.clientId);
    if (!full) return res.status(404).json({ error: 'Campaign not found' });
    res.json(full);
  } catch (err) {
    console.error('[Campaigns] get', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/campaigns', async (req, res) => {
  const c = await db.connect();
  try {
    const name = String((req.body && req.body.name) || 'New campaign').trim() || 'New campaign';
    await c.query('BEGIN');
    const { rows: [client] } = await c.query(
      `INSERT INTO clients (name, voice_prompt, sms_free_site_delay_ms, sms_min_gap_between_texts_ms)
       VALUES ($1, '', 20000, 60000) RETURNING *`,
      [name]
    );
    const { rows: [seq] } = await c.query(
      `INSERT INTO sms_campaign (client_id, name, active, status)
       VALUES ($1, $2, false, 'draft') RETURNING *`,
      [client.id, name]
    );
    await c.query(
      `INSERT INTO sms_campaign_step (campaign_id, sort_order, body_template, delay_after_ms)
       VALUES ($1, 1, $2, 86400000)`,
      [seq.id, '(Draft — write your first SMS for {{business_name}})']
    );
    await c.query('COMMIT');
    const full = await loadFullCampaign(client.id);
    res.status(201).json(full);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[Campaigns] create', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    c.release();
  }
});

router.patch('/admin/campaigns/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const body = req.body || {};
  const c = await db.connect();
  try {
    await c.query('BEGIN');

    // 1) Workspace fields
    const workspace = body.workspace && typeof body.workspace === 'object' ? body.workspace : {};
    const { updates, values } = applyClientPatch(workspace);
    if (updates.length) {
      updates.push('updated_at = now()');
      values.push(clientId);
      await c.query(
        `UPDATE clients SET ${updates.join(', ')} WHERE id = $${values.length}`,
        values
      );
    }

    // 2) Sequence: ensure primary exists, then patch meta + steps
    const seq = await ensurePrimarySequence(clientId, workspace.name);
    const sequence = body.sequence && typeof body.sequence === 'object' ? body.sequence : null;

    if (sequence) {
      if (sequence.meta && typeof sequence.meta === 'object') {
        const meta = sequence.meta;
        await smsCampaign.updateCampaign(clientId, seq.id, {
          name: meta.name,
          timezone: meta.timezone,
          schedule_start: meta.schedule_start,
          schedule_end: meta.schedule_end,
          schedule_days: meta.schedule_days,
          min_gap_between_sends_ms: meta.min_gap_between_sends_ms,
          max_sends_per_day: meta.max_sends_per_day,
          max_new_enrollments_per_day: meta.max_new_enrollments_per_day,
          exclude_other_campaigns: meta.exclude_other_campaigns,
        });
      }
      if (Array.isArray(sequence.steps) && sequence.steps.length) {
        const draftMode = !!body.draft;
        await smsCampaign.replaceSteps(clientId, seq.id, sequence.steps, { draftMode });
      }
    }

    await c.query('COMMIT');
    smsLog.invalidateClientMinGapCache(clientId);
    const full = await loadFullCampaign(clientId);
    res.json(full);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[Campaigns] patch', err.message);
    res.status(400).json({ error: err.message });
  } finally {
    c.release();
  }
});

router.post('/admin/campaigns/:clientId/launch', async (req, res) => {
  const { clientId } = req.params;
  try {
    const full = await loadFullCampaign(clientId);
    if (!full) return res.status(404).json({ error: 'Campaign not found' });
    if (!full.sequence) return res.status(400).json({ error: 'Sequence is missing' });

    // Validate at least one real step body
    const hasBody = full.sequence.steps.some(
      (s) => String(s.body_template || '').trim() && !/^\(Draft —/.test(String(s.body_template || '').trim())
    );
    if (!hasBody) return res.status(400).json({ error: 'Add at least one step with real message text before launching' });
    if (!full.counts.staged_leads) return res.status(400).json({ error: 'Upload leads (CSV) before launching' });

    // Activate workspace + sequence
    await db.query(`UPDATE clients SET active = true, updated_at = now() WHERE id = $1`, [clientId]);
    await db.query(
      `UPDATE sms_campaign SET active = true, status = 'active', updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [full.sequence.id, clientId]
    );

    // Enroll all staged leads
    const phones = await prospects.listProspectPhoneNumbers(clientId);
    const summary = await smsCampaign.enrollLeads(clientId, full.sequence.id, phones);

    const refreshed = await loadFullCampaign(clientId);
    res.json({ ok: true, summary, campaign: refreshed });
  } catch (err) {
    console.error('[Campaigns] launch', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/campaigns/:clientId/pause', async (req, res) => {
  const { clientId } = req.params;
  try {
    await db.query(`UPDATE clients SET active = false, updated_at = now() WHERE id = $1`, [clientId]);
    await db.query(
      `UPDATE sms_campaign SET active = false, status = 'paused', updated_at = now()
       WHERE client_id = $1`,
      [clientId]
    );
    res.json({ ok: true, campaign: await loadFullCampaign(clientId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/campaigns/:clientId/resume', async (req, res) => {
  const { clientId } = req.params;
  try {
    await db.query(`UPDATE clients SET active = true, updated_at = now() WHERE id = $1`, [clientId]);
    await db.query(
      `UPDATE sms_campaign SET active = true, status = 'active', updated_at = now()
       WHERE client_id = $1`,
      [clientId]
    );
    res.json({ ok: true, campaign: await loadFullCampaign(clientId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/campaigns/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE clients SET active = false, archived_at = now(), updated_at = now() WHERE id = $1`, [clientId]);
    await c.query(
      `UPDATE sms_campaign SET active = false, status = 'archived', updated_at = now()
       WHERE client_id = $1`,
      [clientId]
    );
    await c.query(
      `UPDATE sms_campaign_job_queue SET status = 'cancelled'
       WHERE client_id = $1 AND status = 'pending'`,
      [clientId]
    );
    await c.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    c.release();
  }
});

const STANDARD_VARIABLES = [
  'phone',
  'business_name',
  'normalized_name',
  'vertical',
  'city',
  'site_url',
  'sent_status',
  'reply',
  'intent',
  'customer_status',
  'dnc',
];

router.get('/admin/campaigns/:clientId/variables', async (req, res) => {
  const { clientId } = req.params;
  try {
    const sample = await prospects.listProspects(clientId, 50);
    const seen = new Set(STANDARD_VARIABLES);
    const sources = { standard: STANDARD_VARIABLES.slice(), csv: [] };
    for (const p of sample) {
      const vars = prospects.prospectRowToVariables(p);
      for (const k of Object.keys(vars)) {
        if (!seen.has(k)) {
          seen.add(k);
          sources.csv.push(k);
        }
      }
    }
    sources.csv.sort();
    res.json({ variables: Array.from(seen).sort(), sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
