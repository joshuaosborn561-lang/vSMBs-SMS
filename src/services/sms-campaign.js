const db = require('../db');
const sheets = require('../services/sheets');
const { renderSmsTemplate } = require('../utils/sms-template');
const {
  nextAllowedSendAt,
  scheduleAfterDelay,
  applyMinGap,
} = require('../utils/sms-schedule');
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

function campaignIsRunnable(c) {
  if (!c) return false;
  const st = c.status || (c.active ? 'active' : 'paused');
  return st === 'active' && c.active !== false;
}

async function assertClient(clientId) {
  const { rows: [c] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!c) throw new Error('Client not found');
  return c;
}

async function getStagedVariables(clientId, phone) {
  const { rows: [r] } = await db.query(
    `SELECT variables FROM sms_campaign_staged_lead WHERE client_id = $1 AND phone = $2`,
    [clientId, phone]
  );
  return r?.variables && typeof r.variables === 'object' ? r.variables : {};
}

function mergeVariables(sheetVars, stagedVars) {
  return { ...sheetVars, ...stagedVars };
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

async function createCampaign(clientId, body = {}) {
  await assertClient(clientId);
  const n = String(body.name || 'Campaign').trim() || 'Campaign';
  const status = body.status && ['draft', 'active', 'paused', 'archived'].includes(body.status)
    ? body.status
    : 'active';
  const active = status === 'active';
  const { rows: [row] } = await db.query(
    `INSERT INTO sms_campaign (client_id, name, active, status) VALUES ($1, $2, $3, $4) RETURNING *`,
    [clientId, n, active, status]
  );
  return row;
}

async function updateCampaign(clientId, campaignId, body = {}) {
  const allowedSchedule = [
    'timezone', 'schedule_days', 'schedule_start', 'schedule_end',
    'min_gap_between_sends_ms', 'max_sends_per_day', 'max_new_enrollments_per_day',
    'exclude_other_campaigns', 'name', 'status', 'active',
  ];
  const updates = [];
  const vals = [];
  let p = 1;

  for (const key of allowedSchedule) {
    if (body[key] === undefined) continue;
    if (key === 'schedule_days') {
      let days = body.schedule_days;
      if (typeof days === 'string') {
        try {
          days = JSON.parse(days);
        } catch {
          days = [];
        }
      }
      if (Array.isArray(days)) {
        updates.push(`schedule_days = $${p++}`);
        vals.push(days.map((d) => Number(d)).filter((n) => n >= 1 && n <= 7));
      }
      continue;
    }
    if (key === 'status') {
      const st = String(body.status);
      if (!['draft', 'active', 'paused', 'archived'].includes(st)) continue;
      updates.push(`status = $${p++}`);
      vals.push(st);
      updates.push(`active = $${p++}`);
      vals.push(st === 'active');
      continue;
    }
    if (key === 'active') {
      const a = !!body.active;
      updates.push(`active = $${p++}`);
      vals.push(a);
      updates.push(`status = $${p++}`);
      vals.push(a ? 'active' : 'paused');
      continue;
    }
    updates.push(`${key} = $${p++}`);
    vals.push(body[key]);
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
    for (let i = 0; i < steps.length; i += 1) {
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

async function previewSteps(clientId, campaignId, phones) {
  const client = await assertClient(clientId);
  const camp = await getCampaignWithSteps(campaignId, clientId);
  if (!camp || !camp.steps?.length) throw new Error('Campaign or steps not found');

  const prospectTab = client.sheet_tab_prospects || 'Prospects';
  const list = Array.isArray(phones) ? phones : [];
  const results = [];

  for (const rawPhone of list) {
    const phone = String(rawPhone || '').trim();
    if (!phone) continue;

    let variables = { phone };
    let matched = false;
    let sheetRow = null;

    if (client.google_sheet_id) {
      const { row, headers, rowData } = await sheets.findProspectRow(
        client.google_sheet_id,
        prospectTab,
        phone
      );
      matched = !!row;
      sheetRow = row;
      variables = mergeVariables(rowToVariables(headers, rowData, phone), await getStagedVariables(clientId, phone));
    } else {
      variables = mergeVariables({ phone }, await getStagedVariables(clientId, phone));
    }

    const stepsOut = camp.steps.map((st) => ({
      sort_order: st.sort_order,
      delay_after_ms: st.delay_after_ms,
      template: st.body_template,
      rendered: renderSmsTemplate(st.body_template, variables),
    }));
    results.push({
      phone,
      matched,
      sheet_row: sheetRow,
      variables,
      steps: stepsOut,
    });
  }

  return { campaign: { id: camp.id, name: camp.name }, previews: results };
}

async function hasActiveEnrollmentElsewhere(clientId, phone, excludeCampaignId) {
  const { rows: [r] } = await db.query(
    `SELECT 1 FROM sms_campaign_enrollment e
     JOIN sms_campaign c ON c.id = e.campaign_id
     WHERE e.client_id = $1 AND e.lead_phone = $2 AND e.status = 'active'
       AND e.campaign_id <> $3
       AND c.status = 'active' AND c.active = true
     LIMIT 1`,
    [clientId, phone, excludeCampaignId]
  );
  return !!r;
}

async function incrementDailyEnroll(campaignId) {
  await db.query(
    `INSERT INTO sms_campaign_daily_counters (campaign_id, counter_date, enrolls_count)
     VALUES ($1, (CURRENT_TIMESTAMP AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (campaign_id, counter_date)
     DO UPDATE SET enrolls_count = sms_campaign_daily_counters.enrolls_count + 1`,
    [campaignId]
  );
}

async function incrementDailySend(campaignId) {
  await db.query(
    `INSERT INTO sms_campaign_daily_counters (campaign_id, counter_date, sends_count)
     VALUES ($1, (CURRENT_TIMESTAMP AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (campaign_id, counter_date)
     DO UPDATE SET sends_count = sms_campaign_daily_counters.sends_count + 1`,
    [campaignId]
  );
}

async function getDailyCounts(campaignId) {
  const { rows: [r] } = await db.query(
    `SELECT sends_count, enrolls_count FROM sms_campaign_daily_counters
     WHERE campaign_id = $1 AND counter_date = (CURRENT_TIMESTAMP AT TIME ZONE 'utc')::date`,
    [campaignId]
  );
  return { sends: r?.sends_count || 0, enrolls: r?.enrolls_count || 0 };
}

async function enrollLeads(clientId, campaignId, phones, { cancelPendingJobs = true } = {}) {
  const client = await assertClient(clientId);

  const camp = await getCampaignWithSteps(campaignId, clientId);
  if (!camp || !camp.steps?.length) throw new Error('Campaign or steps not found');
  if (!campaignIsRunnable(camp)) throw new Error('Campaign is not active');

  const prospectTab = client.sheet_tab_prospects || 'Prospects';
  const dncTab = client.sheet_tab_dnc || 'DNC';
  const dncKeys = client.google_sheet_id
    ? await sheets.loadDncPhoneKeys(client.google_sheet_id, dncTab)
    : new Set();

  const list = Array.isArray(phones) ? phones : [];
  const summary = {
    enrolled: 0,
    skipped_dnc: 0,
    skipped_duplicate: 0,
    skipped_other_campaign: 0,
    skipped_enrollment_cap: 0,
    errors: [],
  };

  const excludeOther = camp.exclude_other_campaigns !== false;

  for (const rawPhone of list) {
    const phone = String(rawPhone || '').trim();
    if (!phone) continue;

    const keys = sheets.phoneMatchKeys(phone);
    if (keys.some((k) => dncKeys.has(k))) {
      summary.skipped_dnc += 1;
      continue;
    }

    if (camp.max_new_enrollments_per_day != null) {
      const { enrolls } = await getDailyCounts(campaignId);
      if (enrolls >= camp.max_new_enrollments_per_day) {
        summary.skipped_enrollment_cap += 1;
        continue;
      }
    }

    if (excludeOther && (await hasActiveEnrollmentElsewhere(clientId, phone, campaignId))) {
      summary.skipped_other_campaign += 1;
      continue;
    }

    try {
      let variables = { phone };
      if (client.google_sheet_id) {
        const { row, headers, rowData } = await sheets.findProspectRow(
          client.google_sheet_id,
          prospectTab,
          phone
        );
        variables = mergeVariables(rowToVariables(headers, rowData, phone), await getStagedVariables(clientId, phone));
      } else {
        variables = mergeVariables({ phone }, await getStagedVariables(clientId, phone));
      }

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
        let scheduledAt = nextAllowedSendAt(camp, new Date());

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

        if (camp.max_new_enrollments_per_day != null) {
          await incrementDailyEnroll(campaignId);
        }

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

async function cancelJobsForPhone(clientId, phone, reason = 'cancelled') {
  await db.query(
    `UPDATE sms_campaign_job_queue j SET status = 'cancelled'
     FROM sms_campaign_enrollment e
     WHERE j.enrollment_id = e.id AND e.client_id = $1 AND e.lead_phone = $2
       AND j.status = 'pending'`,
    [clientId, phone]
  );
  const { rows } = await db.query(
    `UPDATE sms_campaign_enrollment e SET status = 'cancelled', last_error = $3, updated_at = now()
     WHERE e.client_id = $1 AND e.lead_phone = $2 AND e.status = 'active'
     RETURNING id`,
    [clientId, phone, reason]
  );
  return rows.length;
}

async function handleInboundBranch(clientId, phone, intent) {
  const { rows: enr } = await db.query(
    `SELECT e.id, e.campaign_id, e.lead_phone FROM sms_campaign_enrollment e
     JOIN sms_campaign c ON c.id = e.campaign_id
     WHERE e.client_id = $1 AND e.lead_phone = $2 AND e.status = 'active' AND c.client_id = $1`,
    [clientId, phone]
  );
  if (!enr.length) return { branched: false };

  let rule = null;
  let sourceCampaignId = null;
  for (const e of enr) {
    const { rows: [r] } = await db.query(
      `SELECT * FROM sms_campaign_transition
       WHERE client_id = $1 AND source_campaign_id = $2 AND trigger_intent = $3`,
      [clientId, e.campaign_id, intent]
    );
    if (r) {
      rule = r;
      sourceCampaignId = e.campaign_id;
      break;
    }
  }
  if (!rule) return { branched: false };

  await cancelJobsForPhone(clientId, phone, 'branch_to_other_campaign');
  await db.query(
    `UPDATE sms_campaign_enrollment SET status = 'cancelled', last_error = $4, updated_at = now()
     WHERE client_id = $1 AND lead_phone = $2 AND campaign_id = $3 AND status = 'active'`,
    [clientId, phone, sourceCampaignId, `branched:${rule.target_campaign_id}`]
  );

  const sum = await enrollLeads(clientId, rule.target_campaign_id, [phone], { cancelPendingJobs: true });
  return { branched: true, target_campaign_id: rule.target_campaign_id, enroll: sum };
}

async function listTransitions(clientId) {
  await assertClient(clientId);
  const { rows } = await db.query(
    `SELECT t.*,
       sc.name AS source_name,
       tc.name AS target_name
     FROM sms_campaign_transition t
     JOIN sms_campaign sc ON sc.id = t.source_campaign_id
     JOIN sms_campaign tc ON tc.id = t.target_campaign_id
     WHERE t.client_id = $1 ORDER BY sc.name, t.trigger_intent`,
    [clientId]
  );
  return rows;
}

async function upsertTransition(clientId, { source_campaign_id, target_campaign_id, trigger_intent }) {
  await assertClient(clientId);
  const ti = String(trigger_intent || '').toLowerCase();
  if (!['positive', 'negative', 'question', 'unclassifiable'].includes(ti)) {
    throw new Error('trigger_intent must be positive|negative|question|unclassifiable');
  }
  await getCampaignWithSteps(source_campaign_id, clientId);
  await getCampaignWithSteps(target_campaign_id, clientId);
  await db.query(
    `INSERT INTO sms_campaign_transition (client_id, source_campaign_id, target_campaign_id, trigger_intent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, source_campaign_id, trigger_intent)
     DO UPDATE SET target_campaign_id = EXCLUDED.target_campaign_id`,
    [clientId, source_campaign_id, target_campaign_id, ti]
  );
}

async function deleteTransition(clientId, sourceCampaignId, triggerIntent) {
  await db.query(
    `DELETE FROM sms_campaign_transition
     WHERE client_id = $1 AND source_campaign_id = $2 AND trigger_intent = $3`,
    [clientId, sourceCampaignId, triggerIntent]
  );
}

async function importStagedLeads(clientId, rows, sourceLabel) {
  await assertClient(clientId);
  let imported = 0;
  for (const row of rows) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    const { phone: _p, ...rest } = row;
    await db.query(
      `INSERT INTO sms_campaign_staged_lead (client_id, phone, variables, source_label)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (client_id, phone)
       DO UPDATE SET variables = EXCLUDED.variables, source_label = EXCLUDED.source_label, updated_at = now()`,
      [clientId, phone, JSON.stringify(rest), sourceLabel || null]
    );
    imported += 1;
  }
  return { imported };
}

async function listStagedLeads(clientId, limit = 500) {
  await assertClient(clientId);
  const lim = Math.min(2000, Math.max(1, limit));
  const { rows } = await db.query(
    `SELECT phone, variables, source_label, created_at FROM sms_campaign_staged_lead
     WHERE client_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [clientId, lim]
  );
  return rows;
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

async function lastCampaignSendAt(campaignId) {
  const { rows: [r] } = await db.query(
    `SELECT MAX(sent_at) AS t FROM sms_campaign_job_queue
     WHERE campaign_id = $1 AND status = 'sent' AND sent_at IS NOT NULL`,
    [campaignId]
  );
  return r?.t ? new Date(r.t) : null;
}

async function processDueJobs(batchLimit = 25) {
  const lim = Math.min(100, Math.max(1, batchLimit));
  const { rows: jobs } = await db.query(
    `SELECT j.*
     FROM sms_campaign_job_queue j
     WHERE j.status = 'pending' AND j.scheduled_at <= now()
     ORDER BY j.scheduled_at ASC
     LIMIT $1`,
    [lim]
  );

  const results = { processed: 0, sent: 0, failed: 0, skipped: 0, deferred: 0 };

  for (const job of jobs) {
    const camp = await getCampaignWithSteps(job.campaign_id, job.client_id);
    if (!campaignIsRunnable(camp)) {
      await db.query(`UPDATE sms_campaign_job_queue SET status = 'cancelled' WHERE id = $1`, [job.id]);
      results.skipped += 1;
      continue;
    }

    if (camp.max_sends_per_day != null) {
      const { sends } = await getDailyCounts(job.campaign_id);
      if (sends >= camp.max_sends_per_day) {
        await db.query(
          `UPDATE sms_campaign_job_queue SET scheduled_at = now() + interval '1 minute' WHERE id = $1`,
          [job.id]
        );
        results.deferred += 1;
        continue;
      }
    }

    let scheduledInstant = new Date(job.scheduled_at);
    const winStart = nextAllowedSendAt(camp, scheduledInstant);
    if (winStart.getTime() > Date.now()) {
      await db.query(`UPDATE sms_campaign_job_queue SET scheduled_at = $2 WHERE id = $1`, [job.id, winStart]);
      results.deferred += 1;
      continue;
    }

    const lastSend = await lastCampaignSendAt(job.campaign_id);
    const afterGap = applyMinGap(camp, scheduledInstant, lastSend);
    const readyAt = nextAllowedSendAt(camp, afterGap);
    if (readyAt.getTime() > Date.now()) {
      await db.query(`UPDATE sms_campaign_job_queue SET scheduled_at = $2 WHERE id = $1`, [job.id, readyAt]);
      results.deferred += 1;
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

      if (camp.max_sends_per_day != null) {
        await incrementDailySend(job.campaign_id);
      }

      const steps = camp?.steps || [];
      const completedStep = steps.find((s) => s.sort_order === job.step_order);
      const nextStep = steps.find((s) => s.sort_order === job.step_order + 1);

      if (nextStep) {
        const vars = payload.variables || {};
        const renderedNext = renderSmsTemplate(nextStep.body_template, vars);
        const delayMs = Math.max(0, Number(completedStep?.delay_after_ms) || 0);
        const rawNext = scheduleAfterDelay(camp, new Date(), delayMs);
        let scheduledAt = applyMinGap(camp, rawNext, new Date());
        scheduledAt = nextAllowedSendAt(camp, scheduledAt);

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
  campaignIsRunnable,
  cancelJobsForPhone,
  handleInboundBranch,
  listTransitions,
  upsertTransition,
  deleteTransition,
  importStagedLeads,
  listStagedLeads,
};
