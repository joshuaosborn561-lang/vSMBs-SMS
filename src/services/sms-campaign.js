const db = require('../db');
const sheets = require('../services/sheets');
const { renderSmsTemplate } = require('../utils/sms-template');
const smsLog = require('./sms-log');

const TEMPLATE_KEYS = { 1: 'campaign_step_1', 2: 'campaign_step_2', 3: 'campaign_step_3', 4: 'campaign_step_4', 5: 'campaign_step_5' };

function templateKeyForStep(stepOrder) {
  return TEMPLATE_KEYS[stepOrder] || `campaign_step_${stepOrder}`;
}

/** Row map from sheet headers + phone → variables for {{placeholders}} */
function rowToVariables(headers, rowData, phone) {
  const vars = { phone: String(phone || '').trim() };
  if (!headers || !rowData) return vars;
  for (const [key, colIdx] of Object.entries(headers)) {
    if (colIdx === undefined) continue;
    const cell = rowData[colIdx];
    if (cell != null && cell !== '') vars[key] = String(cell).trim();
  }
  return vars;
}

async function assertClient(clientId) {
  const { rows: [c] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!c) throw new Error('Client not found');
  return c;
}

async function listCampaigns(clientId) {
  await assertClient(clientId);
  const { rows } = await db.query(
    `SELECT c.*,
       (SELECT COUNT(*)::int FROM sms_campaign_enrollment e WHERE e.campaign_id = c.id AND e.status = 'active') AS enrollments_active,
       (SELECT COUNT(*)::int FROM sms_campaign_job_queue j
         JOIN sms_campaign_enrollment e ON e.id = j.enrollment_id
         WHERE e.campaign_id = c.id AND j.status = 'pending') AS jobs_pending
     FROM sms_campaign c WHERE c.client_id = $1 ORDER BY c.created_at DESC`,
    [clientId]
  );
  return rows;
}

async function getCampaignWithSteps(campaignId, clientId) {
  const { rows: [camp] } = await db.query(
    'SELECT * FROM sms_campaign WHERE id = $1 AND client_id = $2',
    [campaignId, clientId]
  );
  if (!camp) return null;
  const { rows: steps } = await db.query(
    'SELECT * FROM sms_campaign_step WHERE campaign_id = $1 ORDER BY sort_order ASC',
    [campaignId]
  );
  return { ...camp, steps };
}

async function createCampaign(clientId, { name }) {
  await assertClient(clientId);
  const n = String(name || 'Campaign').trim() || 'Campaign';
  const { rows: [row] } = await db.query(
    `INSERT INTO sms_campaign (client_id, name) VALUES ($1, $2) RETURNING *`,
    [clientId, n]
  );
  return row;
}

async function updateCampaign(clientId, campaignId, { name, active }) {
  const updates = [];
  const vals = [];
  let p = 1;
  if (name !== undefined) {
    updates.push(`name = $${p++}`);
    vals.push(String(name).trim() || 'Campaign');
  }
  if (active !== undefined) {
    updates.push(`active = $${p++}`);
    vals.push(!!active);
  }
  if (!updates.length) return getCampaignWithSteps(campaignId, clientId);
  updates.push('updated_at = now()');
  vals.push(campaignId, clientId);
  await db.query(
    `UPDATE sms_campaign SET ${updates.join(', ')} WHERE id = $${p} AND client_id = $${p + 1}`,
    vals
  );
  return getCampaignWithSteps(campaignId, clientId);
}

async function replaceSteps(clientId, campaignId, stepsInput) {
  const camp = await getCampaignWithSteps(campaignId, clientId);
  if (!camp) throw new Error('Campaign not found');

  const steps = Array.isArray(stepsInput) ? stepsInput : [];
  if (!steps.length) throw new Error('At least one sequence step is required');

  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM sms_campaign_step WHERE campaign_id = $1', [campaignId]);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const sortOrder = i + 1;
      const body = String(s.body_template || s.body || '').trim();
      if (!body) throw new Error(`Step ${sortOrder}: body is required`);
      const delayMs = Math.max(0, parseInt(s.delay_after_ms ?? s.delay_ms ?? 86400000, 10) || 0);
      await db.query(
        `INSERT INTO sms_campaign_step (campaign_id, sort_order, body_template, delay_after_ms)
         VALUES ($1, $2, $3, $4)`,
        [campaignId, sortOrder, body, delayMs]
      );
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
  return getCampaignWithSteps(campaignId, clientId);
}

/**
 * Preview: for each phone, load sheet row and render each step.
 */
async function previewCampaign(clientId, campaignId, phones) {
  return previewSteps(clientId, campaignId, phones);
}

async function previewSteps(clientId, campaignId, phones) {
  const client = await assertClient(clientId);
  if (!client.google_sheet_id) throw new Error('google_sheet_id not set');
  const camp = await getCampaignWithSteps(campaignId, clientId);
  if (!camp || !camp.steps?.length) throw new Error('Campaign or steps not found');

  const prospectTab = client.sheet_tab_prospects || 'Prospects';
  const list = Array.isArray(phones) ? phones : [];
  const results = [];

  for (const rawPhone of list) {
    const phone = String(rawPhone || '').trim();
    if (!phone) continue;
    const { row, headers, rowData } = await sheets.findProspectRow(
      client.google_sheet_id,
      prospectTab,
      phone
    );
    const variables = rowToVariables(headers, rowData, phone);
    const stepsOut = camp.steps.map((st) => ({
      sort_order: st.sort_order,
      delay_after_ms: st.delay_after_ms,
      template: st.body_template,
      rendered: renderSmsTemplate(st.body_template, variables),
    }));
    results.push({
      phone,
      matched: !!row,
      sheet_row: row,
      variables,
      steps: stepsOut,
    });
  }

  return { campaign: { id: camp.id, name: camp.name }, previews: results };
}

async function enrollLeads(clientId, campaignId, phones, { cancelPendingJobs = true } = {}) {
  const client = await assertClient(clientId);
  if (!client.google_sheet_id) throw new Error('google_sheet_id not set');

  const camp = await getCampaignWithSteps(campaignId, clientId);
  if (!camp || !camp.steps?.length) throw new Error('Campaign or steps not found');
  if (!camp.active) throw new Error('Campaign is not active');

  const prospectTab = client.sheet_tab_prospects || 'Prospects';
  const dncTab = client.sheet_tab_dnc || 'DNC';
  const dncKeys = await sheets.loadDncPhoneKeys(client.google_sheet_id, dncTab);

  const list = Array.isArray(phones) ? phones : [];
  const summary = { enrolled: 0, skipped_dnc: 0, skipped_duplicate: 0, errors: [] };

  for (const rawPhone of list) {
    const phone = String(rawPhone || '').trim();
    if (!phone) continue;

    const keys = sheets.phoneMatchKeys(phone);
    if (keys.some((k) => dncKeys.has(k))) {
      summary.skipped_dnc += 1;
      continue;
    }

    try {
      const { row, headers, rowData } = await sheets.findProspectRow(
        client.google_sheet_id,
        prospectTab,
        phone
      );
      const variables = rowToVariables(headers, rowData, phone);

      await db.query('BEGIN');
      try {
        const { rows: [existing] } = await db.query(
          `SELECT id, status FROM sms_campaign_enrollment WHERE campaign_id = $1 AND lead_phone = $2`,
          [campaignId, phone]
        );
        if (existing && existing.status === 'active') {
          summary.skipped_duplicate += 1;
          await db.query('ROLLBACK');
          continue;
        }

        let enrollmentId;
        if (existing) {
          await db.query(
            `UPDATE sms_campaign_enrollment SET
               variables = $1::jsonb, current_step = 1, status = 'active', last_error = NULL, updated_at = now()
             WHERE id = $2`,
            [JSON.stringify(variables), existing.id]
          );
          enrollmentId = existing.id;
          if (cancelPendingJobs) {
            await db.query(
              `UPDATE sms_campaign_job_queue SET status = 'cancelled'
               WHERE enrollment_id = $1 AND status = 'pending'`,
              [enrollmentId]
            );
          }
        } else {
          const { rows: [ins] } = await db.query(
            `INSERT INTO sms_campaign_enrollment (campaign_id, client_id, lead_phone, variables, current_step, status)
             VALUES ($1, $2, $3, $4::jsonb, 1, 'active') RETURNING id`,
            [campaignId, clientId, phone, JSON.stringify(variables)]
          );
          enrollmentId = ins.id;
        }

        const firstStep = camp.steps[0];
        const rendered = renderSmsTemplate(firstStep.body_template, variables);
        const payload = {
          body: rendered,
          template: firstStep.body_template,
          variables,
        };
        const scheduledAt = new Date();

        await db.query(
          `INSERT INTO sms_campaign_job_queue
            (enrollment_id, campaign_id, client_id, lead_phone, step_order, payload, scheduled_at, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending')`,
          [
            enrollmentId,
            campaignId,
            clientId,
            phone,
            firstStep.sort_order,
            JSON.stringify(payload),
            scheduledAt,
          ]
        );

        await db.query('COMMIT');
        summary.enrolled += 1;
      } catch (e) {
        await db.query('ROLLBACK');
        summary.errors.push({ phone, error: e.message });
      }
    } catch (e) {
      summary.errors.push({ phone, error: e.message });
    }
  }

  return summary;
}

async function listEnrollments(clientId, campaignId, limit = 200) {
  await assertClient(clientId);
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));
  const { rows } = await db.query(
    `SELECT * FROM sms_campaign_enrollment
     WHERE campaign_id = $1 AND client_id = $2
     ORDER BY updated_at DESC LIMIT $3`,
    [campaignId, clientId, lim]
  );
  return rows;
}

async function listJobs(clientId, campaignId, limit = 100) {
  await assertClient(clientId);
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const { rows } = await db.query(
    `SELECT j.* FROM sms_campaign_job_queue j
     WHERE j.campaign_id = $1 AND j.client_id = $2
     ORDER BY j.scheduled_at DESC LIMIT $3`,
    [campaignId, clientId, lim]
  );
  return rows;
}

async function processDueJobs(batchLimit = 25) {
  const lim = Math.min(100, Math.max(1, batchLimit));
  const { rows: jobs } = await db.query(
    `SELECT j.*, c.active AS campaign_active
     FROM sms_campaign_job_queue j
     JOIN sms_campaign c ON c.id = j.campaign_id
     WHERE j.status = 'pending' AND j.scheduled_at <= now()
     ORDER BY j.scheduled_at ASC
     LIMIT $1`,
    [lim]
  );

  const results = { processed: 0, sent: 0, failed: 0, skipped: 0 };

  for (const job of jobs) {
    if (!job.campaign_active) {
      await db.query(`UPDATE sms_campaign_job_queue SET status = 'cancelled' WHERE id = $1`, [job.id]);
      results.skipped += 1;
      continue;
    }

    const lock = await db.query(
      `UPDATE sms_campaign_job_queue SET status = 'sending' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [job.id]
    );
    if (!lock.rowCount) continue;
    results.processed += 1;

    const payload = job.payload || {};
    const body = String(payload.body || '').trim();
    if (!body) {
      await db.query(
        `UPDATE sms_campaign_job_queue SET status = 'failed', error_message = $2, sent_at = now() WHERE id = $1`,
        [job.id, 'empty body']
      );
      await db.query(
        `UPDATE sms_campaign_enrollment SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
        [job.enrollment_id, 'empty body']
      );
      results.failed += 1;
      continue;
    }

    const templateKey = templateKeyForStep(job.step_order);

    try {
      await smsLog.sendSmsLogged({
        clientId: job.client_id,
        leadPhone: job.lead_phone,
        body,
        templateKey,
        variables: payload.variables || {},
      });
      await db.query(
        `UPDATE sms_campaign_job_queue SET status = 'sent', sent_at = now(), error_message = NULL WHERE id = $1`,
        [job.id]
      );

      const camp = await getCampaignWithSteps(job.campaign_id, job.client_id);
      const steps = camp?.steps || [];
      const completedStep = steps.find((s) => s.sort_order === job.step_order);
      const nextStep = steps.find((s) => s.sort_order === job.step_order + 1);

      if (nextStep) {
        const vars = payload.variables || {};
        const renderedNext = renderSmsTemplate(nextStep.body_template, vars);
        const delayMs = Math.max(0, Number(completedStep?.delay_after_ms) || 0);
        const scheduledAt = new Date(Date.now() + delayMs);
        await db.query(
          `INSERT INTO sms_campaign_job_queue
            (enrollment_id, campaign_id, client_id, lead_phone, step_order, payload, scheduled_at, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending')`,
          [
            job.enrollment_id,
            job.campaign_id,
            job.client_id,
            job.lead_phone,
            nextStep.sort_order,
            JSON.stringify({
              body: renderedNext,
              template: nextStep.body_template,
              variables: vars,
            }),
            scheduledAt,
          ]
        );
        await db.query(
          `UPDATE sms_campaign_enrollment SET current_step = $2, updated_at = now() WHERE id = $1`,
          [job.enrollment_id, nextStep.sort_order]
        );
      } else {
        await db.query(
          `UPDATE sms_campaign_enrollment SET status = 'completed', current_step = $2, updated_at = now() WHERE id = $1`,
          [job.enrollment_id, job.step_order]
        );
      }

      results.sent += 1;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 2000);
      await db.query(
        `UPDATE sms_campaign_job_queue SET status = 'failed', error_message = $2, sent_at = now() WHERE id = $1`,
        [job.id, msg]
      );
      await db.query(
        `UPDATE sms_campaign_enrollment SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
        [job.enrollment_id, msg]
      );
      results.failed += 1;
    }
  }

  return results;
}

module.exports = {
  listCampaigns,
  getCampaignWithSteps,
  createCampaign,
  updateCampaign,
  replaceSteps,
  previewCampaign: previewSteps,
  enrollLeads,
  listEnrollments,
  listJobs,
  processDueJobs,
  rowToVariables,
  templateKeyForStep,
};
