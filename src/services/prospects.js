const sheets = require('./sheets');
const { getSupabase, supabaseConfigured } = require('./supabase-client');

function requireSupabase() {
  const sb = getSupabase();
  if (!sb) {
    throw new Error(
      'Supabase is required for prospects/DNC: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }
  return sb;
}

function normalizePhoneDisplay(raw) {
  return String(raw || '').trim();
}

function mapSbProspect(r) {
  if (!r) return null;
  return {
    id: r.id,
    client_id: r.client_id,
    phone_e164: r.phone_e164,
    business_name: r.business_name,
    vertical: r.vertical,
    city: r.city,
    sent_status: r.sent_status,
    reply: r.reply,
    intent: r.intent,
    site_url: r.site_url,
    customer_status: r.customer_status,
    is_dnc: !!r.is_dnc,
    extra: r.extra && typeof r.extra === 'object' ? r.extra : {},
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Variables for {{templates}} from sms_prospect row + extra JSON */
function prospectRowToVariables(row) {
  if (!row) return {};
  const extra = row.extra && typeof row.extra === 'object' ? row.extra : {};
  const base = {
    phone: row.phone_e164 || '',
    business_name: row.business_name || '',
    vertical: row.vertical || '',
    city: row.city || '',
    sent_status: row.sent_status || '',
    reply: row.reply || '',
    intent: row.intent || '',
    site_url: row.site_url || '',
    customer_status: row.customer_status || '',
    dnc: row.is_dnc ? 'yes' : 'no',
  };
  const merged = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k).trim().toLowerCase().replace(/\s+/g, '_');
    if (v != null && v !== '') merged[key] = String(v).trim();
  }
  return merged;
}

async function fetchClientProspects(clientId) {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from('sms_prospect')
    .select('*')
    .eq('client_id', clientId)
    .limit(10000);
  if (error) throw new Error(error.message);
  return (data || []).map(mapSbProspect);
}

async function findProspectByPhone(clientId, rawPhone) {
  const keys = sheets.phoneMatchKeys(rawPhone);
  if (!keys.length) return { row: null };

  const rows = await fetchClientProspects(clientId);
  for (const r of rows) {
    const rk = sheets.phoneMatchKeys(r.phone_e164);
    if (keys.some((k) => rk.includes(k))) return { row: r };
  }
  return { row: null };
}

async function isPhoneOnDnc(clientId, rawPhone) {
  const keys = sheets.phoneMatchKeys(rawPhone);
  const rows = await fetchClientProspects(clientId);
  for (const r of rows) {
    if (!r.is_dnc) continue;
    const rk = sheets.phoneMatchKeys(r.phone_e164);
    if (keys.some((k) => rk.includes(k))) return true;
  }
  return false;
}

async function loadDncPhoneKeys(clientId) {
  const set = new Set();
  const rows = await fetchClientProspects(clientId);
  for (const r of rows) {
    if (!r.is_dnc) continue;
    sheets.phoneMatchKeys(r.phone_e164).forEach((k) => set.add(k));
  }
  return set;
}

async function upsertProspect(clientId, fields) {
  const sb = requireSupabase();
  const phone = normalizePhoneDisplay(fields.phone_e164 || fields.phone);
  if (!phone) throw new Error('phone required');

  const extraIn = fields.extra && typeof fields.extra === 'object' ? fields.extra : {};
  const { row: existingRow } = await findProspectByPhone(clientId, phone);
  const mergedExtra = { ...(existingRow?.extra || {}), ...extraIn };

  const row = {
    client_id: clientId,
    phone_e164: phone,
    business_name: fields.business_name !== undefined ? fields.business_name : existingRow?.business_name ?? null,
    vertical: fields.vertical !== undefined ? fields.vertical : existingRow?.vertical ?? null,
    city: fields.city !== undefined ? fields.city : existingRow?.city ?? null,
    sent_status: fields.sent_status !== undefined ? fields.sent_status : existingRow?.sent_status ?? null,
    reply: fields.reply !== undefined ? fields.reply : existingRow?.reply ?? null,
    intent: fields.intent !== undefined ? fields.intent : existingRow?.intent ?? null,
    site_url: fields.site_url !== undefined ? fields.site_url : existingRow?.site_url ?? null,
    customer_status: fields.customer_status !== undefined ? fields.customer_status : existingRow?.customer_status ?? null,
    is_dnc: fields.is_dnc !== undefined ? !!fields.is_dnc : !!existingRow?.is_dnc,
    extra: mergedExtra,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from('sms_prospect')
    .upsert(row, { onConflict: 'client_id,phone_e164' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return mapSbProspect(data);
}

async function patchOrCreateProspect(clientId, rawPhone, patch) {
  const phone = normalizePhoneDisplay(rawPhone);
  if (!phone) return null;
  const scalar = {};
  const scalars = ['business_name', 'vertical', 'city', 'sent_status', 'reply', 'intent', 'site_url', 'customer_status'];
  for (const k of scalars) {
    if (patch[k] !== undefined) scalar[k] = patch[k];
  }
  if (patch.dnc !== undefined) scalar.is_dnc = patch.dnc === true || patch.dnc === 'yes';
  return upsertProspect(clientId, {
    phone_e164: phone,
    ...scalar,
    extra: patch.extra || {},
  });
}

async function patchProspectFields(clientId, rawPhone, patch) {
  const { row } = await findProspectByPhone(clientId, rawPhone);
  if (!row) return patchOrCreateProspect(clientId, rawPhone, patch);

  const sb = requireSupabase();

  const updates = {
    updated_at: new Date().toISOString(),
  };

  if (patch.dnc !== undefined) {
    updates.is_dnc = patch.dnc === true || patch.dnc === 'yes' || patch.dnc === 'true';
  }
  const scalars = ['business_name', 'vertical', 'city', 'sent_status', 'reply', 'intent', 'site_url', 'customer_status'];
  for (const k of scalars) {
    if (patch[k] !== undefined) updates[k] = patch[k];
  }
  if (patch.extra && typeof patch.extra === 'object') {
    updates.extra = { ...(row.extra || {}), ...patch.extra };
  }

  const { data, error } = await sb
    .from('sms_prospect')
    .update(updates)
    .eq('id', row.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return mapSbProspect(data);
}

async function appendDnc(clientId, rawPhone, reason) {
  const phone = normalizePhoneDisplay(rawPhone);
  const keys = sheets.phoneMatchKeys(phone);
  let targetPhone = phone;
  const rows = await fetchClientProspects(clientId);
  for (const r of rows) {
    const rk = sheets.phoneMatchKeys(r.phone_e164);
    if (keys.some((k) => rk.includes(k))) {
      targetPhone = r.phone_e164;
      break;
    }
  }

  const extra = {
    dnc_reason: reason || 'dnc',
    dnc_at: new Date().toISOString(),
  };

  await upsertProspect(clientId, {
    phone_e164: targetPhone,
    is_dnc: true,
    customer_status: 'dnc',
    intent: reason || 'dnc',
    extra,
  });
}

async function upsertManyFromCsvRows(clientId, rows) {
  let upserted = 0;
  for (const obj of rows) {
    const phone = String(obj.phone || obj.phone_e164 || '').trim();
    if (!phone) continue;
    const extra = { ...obj };
    delete extra.phone;
    delete extra.phone_e164;
    delete extra.business_name;
    delete extra.vertical;
    delete extra.city;
    delete extra.sent_status;
    delete extra.reply;
    delete extra.intent;
    delete extra.site_url;
    delete extra.customer_status;

    if (obj.upload_source != null && obj.upload_source !== '') {
      extra.upload_source = obj.upload_source;
    }

    await upsertProspect(clientId, {
      phone_e164: phone,
      business_name: obj.business_name,
      vertical: obj.vertical,
      city: obj.city,
      sent_status: obj.sent_status,
      reply: obj.reply,
      intent: obj.intent,
      site_url: obj.site_url,
      customer_status: obj.customer_status,
      extra,
    });
    upserted += 1;
  }
  return upserted;
}

async function listProspects(clientId, limit = 500) {
  const sb = requireSupabase();
  const lim = Math.min(2000, Math.max(1, limit));
  const { data, error } = await sb
    .from('sms_prospect')
    .select('*')
    .eq('client_id', clientId)
    .order('updated_at', { ascending: false })
    .limit(lim);
  if (error) throw new Error(error.message);
  return (data || []).map(mapSbProspect);
}

module.exports = {
  supabaseConfigured,
  findProspectByPhone,
  prospectRowToVariables,
  isPhoneOnDnc,
  loadDncPhoneKeys,
  upsertProspect,
  patchProspectFields,
  patchOrCreateProspect,
  appendDnc,
  upsertManyFromCsvRows,
  listProspects,
  normalizePhoneDisplay,
};
