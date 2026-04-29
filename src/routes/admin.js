const { Router } = require('express');
const db = require('../db');
const smsLog = require('../services/sms-log');

const router = Router();

function webhookUrls(clientId) {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + (process.env.PORT || 3000);
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return {
    smartlead_webhook_url: `${protocol}://${domain}/webhook/smartlead/${clientId}`,
    heyreach_webhook_url: `${protocol}://${domain}/webhook/heyreach/${clientId}`,
    sms_webhook_url: `${protocol}://${domain}/webhook/sms/${clientId}`,
    gmail_connect_url: `${protocol}://${domain}/auth/gmail/connect/${clientId}`,
  };
}

function formatClient(client) {
  return { ...client, ...webhookUrls(client.id) };
}

// Create client
router.post('/admin/clients', async (req, res) => {
  try {
    const {
      name, smartlead_api_key, heyreach_api_key, slack_bot_token,
      slack_channel_id, booking_link, calendly_personal_access_token, voice_prompt,
      google_sheet_id, sheet_tab_prospects, sheet_tab_dnc, sheet_tab_settings,
      sheet_tab_email_log, settings_last_email_check_cell,
      sms_free_site_body, sms_free_site_delay_ms,
      sms_min_gap_between_texts_ms,
    } = req.body;

    if (!name || !slack_bot_token || !slack_channel_id) {
      return res.status(400).json({ error: 'name, slack_bot_token, and slack_channel_id are required' });
    }

    const { rows: [client] } = await db.query(
      `INSERT INTO clients (
        name, smartlead_api_key, heyreach_api_key, slack_bot_token, slack_channel_id,
        booking_link, calendly_personal_access_token, voice_prompt,
        google_sheet_id, sheet_tab_prospects, sheet_tab_dnc, sheet_tab_settings,
        sheet_tab_email_log, settings_last_email_check_cell,
        sms_free_site_body, sms_free_site_delay_ms, sms_min_gap_between_texts_ms
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [
        name,
        smartlead_api_key || null,
        heyreach_api_key || null,
        slack_bot_token,
        slack_channel_id,
        booking_link || null,
        calendly_personal_access_token || null,
        voice_prompt || '',
        google_sheet_id || null,
        sheet_tab_prospects || null,
        sheet_tab_dnc || null,
        sheet_tab_settings || null,
        sheet_tab_email_log || null,
        settings_last_email_check_cell || null,
        sms_free_site_body || null,
        sms_free_site_delay_ms != null && sms_free_site_delay_ms !== ''
          ? Number(sms_free_site_delay_ms)
          : 20000,
        sms_min_gap_between_texts_ms != null && sms_min_gap_between_texts_ms !== ''
          ? Math.max(0, Number(sms_min_gap_between_texts_ms))
          : 60000,
      ]
    );

    console.log('[Admin] Client created', { id: client.id, name: client.name });
    res.status(201).json(formatClient(client));
  } catch (err) {
    console.error('[Admin] Create client error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// List clients
router.get('/admin/clients', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(rows.map(formatClient));
  } catch (err) {
    console.error('[Admin] List clients error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Update client
router.patch('/admin/clients/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const fields = req.body;
    const allowedFields = [
      'name', 'smartlead_api_key', 'heyreach_api_key', 'slack_bot_token',
      'slack_channel_id', 'booking_link', 'calendly_personal_access_token', 'voice_prompt', 'active',
      'google_sheet_id', 'sheet_tab_prospects', 'sheet_tab_dnc', 'sheet_tab_settings',
      'sheet_tab_email_log', 'settings_last_email_check_cell',
      'gmail_watcher_started_at',
      'sms_free_site_body', 'sms_free_site_delay_ms',
      'sms_min_gap_between_texts_ms',
    ];

    const updates = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (!allowedFields.includes(key)) continue;
      let v = value;
      if (key === 'sms_min_gap_between_texts_ms') {
        v = Math.max(0, Number(v) || 0);
      }
      updates.push(`${key} = $${idx}`);
      values.push(v);
      idx++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push(`updated_at = now()`);
    values.push(clientId);

    const { rows: [client] } = await db.query(
      `UPDATE clients SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    smsLog.invalidateClientMinGapCache(clientId);
    console.log('[Admin] Client updated', { id: client.id, name: client.name });
    res.json(formatClient(client));
  } catch (err) {
    console.error('[Admin] Update client error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
