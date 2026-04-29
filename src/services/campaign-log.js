const { getSupabase } = require('./supabase-client');

async function listCampaignEvents(clientId, limit = 100) {
  const sb = getSupabase();
  if (!sb) return [];
  const lim = Math.min(500, Math.max(1, limit));
  const { data, error } = await sb
    .from('campaign_event_log')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(lim);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Audit trail in Supabase table campaign_event_log (optional — no-op if Supabase unset).
 */
async function logCampaignEvent(clientId, { campaignId, enrollmentId, jobId, eventType, payload }) {
  const sb = getSupabase();
  if (!sb || !clientId || !eventType) return;
  try {
    await sb.from('campaign_event_log').insert({
      client_id: clientId,
      campaign_id: campaignId || null,
      enrollment_id: enrollmentId || null,
      job_id: jobId || null,
      event_type: eventType,
      payload: payload && typeof payload === 'object' ? payload : {},
    });
  } catch (e) {
    console.warn('[CampaignLog] Supabase insert failed', e.message);
  }
}

module.exports = { logCampaignEvent, listCampaignEvents };
