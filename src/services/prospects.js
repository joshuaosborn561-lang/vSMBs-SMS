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

/**
 * Canonical E.164 for storage + unique (client_id, phone_e164).
 * NANP: 10-digit national or 11-digit starting with 1 → +1XXXXXXXXXX so
 * "5551234567", "15551234567", and "+15551234567" dedupe in Supabase.
 * Other regions: if the value is all digits and length ≥ 8, prefix "+".
 */
function canonicalPhoneForProspect(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  const d = sheets.digitsOnly(trimmed);
  if (!d) return trimmed;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 8 && d.length <= 15 && /^\d+$/.test(trimmed.replace(/\s/g, ''))) {
    return `+${d}`;
  }
  return trimmed;
}

/** DB `phone_e164` values that should match the same NANP canonical (+1…). */
function phoneColumnQueryVariants(canonical) {
  const c = String(canonical || '').trim();
  if (!c) return [];
  const d = sheets.digitsOnly(c);
  const variants = new Set([c]);
  if (d.length === 11 && d.startsWith('1')) {
    variants.add(d);
    variants.add(d.slice(1));
  } else if (d.length === 10) {
    variants.add(d);
    variants.add(`1${d}`);
    variants.add(`+1${d}`);
  }
  return [...variants];
}

function mergeScalarPreferIncoming(incoming, existingVal, fallback) {
  if (incoming !== undefined) return incoming;
  if (existingVal !== undefined && existingVal !== null && existingVal !== '') return existingVal;
  return fallback ?? null;
}

function mergeExtraObjects(...objects) {
  const out = {};
  for (const o of objects) {
    if (!o || typeof o !== 'object') continue;
    for (const [k, v] of Object.entries(o)) {
      if (v != null && v !== '') out[k] = v;
    }
  }
  return out;
}

/** Merge several sms_prospect rows (same logical NANP phone) into one payload. */
function aggregateProspectRowsForUpsert(rows, fields) {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const base = sorted[0] || {};
  const extraIn = fields.extra && typeof fields.extra === 'object' ? fields.extra : {};
  const mergedExtra = mergeExtraObjects(...sorted.map((r) => r.extra), extraIn);

  const pickBool = (key) => {
    if (fields[key] !== undefined) return !!fields[key];
    if (sorted.some((r) => r && r[key])) return true;
    return !!base[key];
  };

  return {
    business_name: mergeScalarPreferIncoming(
      fields.business_name,
      sorted.map((r) => r.business_name).find((v) => v != null && v !== ''),
      base.business_name
    ),
    normalized_name: mergeScalarPreferIncoming(
      fields.normalized_name,
      sorted.map((r) => r.normalized_name).find((v) => v != null && v !== ''),
      base.normalized_name
    ),
    vertical: mergeScalarPreferIncoming(
      fields.vertical,
      sorted.map((r) => r.vertical).find((v) => v != null && v !== ''),
      base.vertical
    ),
    city: mergeScalarPreferIncoming(
      fields.city,
      sorted.map((r) => r.city).find((v) => v != null && v !== ''),
      base.city
    ),
    sent_status: mergeScalarPreferIncoming(
      fields.sent_status,
      sorted.map((r) => r.sent_status).find((v) => v != null && v !== ''),
      base.sent_status
    ),
    reply: mergeScalarPreferIncoming(
      fields.reply,
      sorted.map((r) => r.reply).find((v) => v != null && v !== ''),
      base.reply
    ),
    intent: mergeScalarPreferIncoming(
      fields.intent,
      sorted.map((r) => r.intent).find((v) => v != null && v !== ''),
      base.intent
    ),
    site_url: mergeScalarPreferIncoming(
      fields.site_url,
      sorted.map((r) => r.site_url).find((v) => v != null && v !== ''),
      base.site_url
    ),
    customer_status: mergeScalarPreferIncoming(
      fields.customer_status,
      sorted.map((r) => r.customer_status).find((v) => v != null && v !== ''),
      base.customer_status
    ),
    is_dnc: pickBool('is_dnc'),
    extra: mergedExtra,
  };
}

async function fetchProspectsByPhoneVariants(sb, clientId, canonical) {
  const variants = phoneColumnQueryVariants(canonical);
  if (!variants.length) return [];
  const { data, error } = await sb
    .from('sms_prospect')
    .select('*')
    .eq('client_id', clientId)
    .in('phone_e164', variants);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * When legacy data has two rows (e.g. +1555… and 555…), merge into one canonical row.
 * Keeps the row that already uses `canonical` if present, else the oldest `id`.
 */
async function consolidateProspectPhoneDuplicates(sb, clientId, canonical, existingRows) {
  const rows = existingRows || (await fetchProspectsByPhoneVariants(sb, clientId, canonical));
  if (rows.length <= 1) return rows[0] || null;

  const byCanon = rows.find((r) => r.phone_e164 === canonical);
  const survivor = byCanon || [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  const merged = aggregateProspectRowsForUpsert(rows, {});

  for (const r of rows) {
    if (r.id !== survivor.id) {
      const { error: delErr } = await sb.from('sms_prospect').delete().eq('id', r.id);
      if (delErr) throw new Error(delErr.message);
    }
  }

  const payload = {
    ...merged,
    phone_e164: canonical,
    client_id: clientId,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from('sms_prospect')
    .update(payload)
    .eq('id', survivor.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** @deprecated Prefer canonicalPhoneForProspect; kept for callers expecting a “display” normalizer. */
function normalizePhoneDisplay(raw) {
  return canonicalPhoneForProspect(raw);
}

function mapSbProspect(r) {
  if (!r) return null;
  return {
    id: r.id,
    client_id: r.client_id,
    phone_e164: r.phone_e164,
    business_name: r.business_name,
    normalized_name: r.normalized_name || null,
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
    normalized_name: row.normalized_name || '',
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

  const sb = getSupabase();
  const canonical = canonicalPhoneForProspect(rawPhone);
  if (sb && canonical) {
    try {
      const variantRows = (await fetchProspectsByPhoneVariants(sb, clientId, canonical)).map(mapSbProspect);
      for (const r of variantRows) {
        const rk = sheets.phoneMatchKeys(r.phone_e164);
        if (keys.some((k) => rk.includes(k))) return { row: r };
      }
    } catch (e) {
      /* fall back to full table scan */
    }
  }

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
  const canonical = canonicalPhoneForProspect(fields.phone_e164 || fields.phone);
  if (!canonical) throw new Error('phone required');

  let variantRows = await fetchProspectsByPhoneVariants(sb, clientId, canonical);
  if (variantRows.length > 1) {
    await consolidateProspectPhoneDuplicates(sb, clientId, canonical, variantRows);
    variantRows = await fetchProspectsByPhoneVariants(sb, clientId, canonical);
  }

  if (variantRows.length === 1 && variantRows[0].phone_e164 !== canonical) {
    const { error: renErr } = await sb
      .from('sms_prospect')
      .update({ phone_e164: canonical, updated_at: new Date().toISOString() })
      .eq('id', variantRows[0].id);
    if (renErr) throw new Error(renErr.message);
    variantRows = [{ ...variantRows[0], phone_e164: canonical }];
  }

  const extraIn = fields.extra && typeof fields.extra === 'object' ? fields.extra : {};
  const mergedScalars = aggregateProspectRowsForUpsert(variantRows, fields);
  const row = {
    client_id: clientId,
    phone_e164: canonical,
    ...mergedScalars,
    extra: mergeExtraObjects(...variantRows.map((r) => r.extra), extraIn),
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
  const phone = canonicalPhoneForProspect(rawPhone);
  if (!phone) return null;
  const scalar = {};
  const scalars = ['business_name', 'normalized_name', 'vertical', 'city', 'sent_status', 'reply', 'intent', 'site_url', 'customer_status'];
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
  const scalars = ['business_name', 'normalized_name', 'vertical', 'city', 'sent_status', 'reply', 'intent', 'site_url', 'customer_status'];
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
  const keys = sheets.phoneMatchKeys(rawPhone);
  const canonical = canonicalPhoneForProspect(rawPhone);
  let targetPhone = canonical || String(rawPhone || '').trim();
  const rows = await fetchClientProspects(clientId);
  for (const r of rows) {
    const rk = sheets.phoneMatchKeys(r.phone_e164);
    if (keys.some((k) => rk.includes(k))) {
      targetPhone = canonicalPhoneForProspect(r.phone_e164) || r.phone_e164;
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
  const supabaseHasNormalizedName = await hasNormalizedNameColumn();
  for (const obj of rows) {
    const phone = String(obj.phone || obj.phone_e164 || '').trim();
    if (!phone) continue;
    const extra = { ...obj };
    delete extra.phone;
    delete extra.phone_e164;
    delete extra.business_name;
    delete extra.normalized_name;
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
    // If Supabase doesn't have normalized_name yet, fall back to extra so
    // {{normalized_name}} still resolves at render time.
    if (!supabaseHasNormalizedName && obj.normalized_name != null && obj.normalized_name !== '') {
      extra.normalized_name = obj.normalized_name;
    }

    await upsertProspect(clientId, {
      phone_e164: phone,
      business_name: obj.business_name,
      normalized_name: supabaseHasNormalizedName ? obj.normalized_name : undefined,
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

let _normalizedNameColumnCache = null;
async function hasNormalizedNameColumn() {
  if (_normalizedNameColumnCache != null) return _normalizedNameColumnCache;
  const sb = getSupabase();
  if (!sb) return false;
  try {
    const { error } = await sb.from('sms_prospect').select('normalized_name').limit(1);
    _normalizedNameColumnCache = !error;
  } catch (e) {
    _normalizedNameColumnCache = false;
  }
  return _normalizedNameColumnCache;
}

function _resetNormalizedNameColumnCache() {
  _normalizedNameColumnCache = null;
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

async function countProspects(clientId) {
  const sb = requireSupabase();
  const { count, error } = await sb
    .from('sms_prospect')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);
  if (error) throw new Error(error.message);
  return Number(count || 0);
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
  hasNormalizedNameColumn,
  _resetNormalizedNameColumnCache,
  countProspects,
};
