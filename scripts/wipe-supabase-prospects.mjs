#!/usr/bin/env node
/**
 * Delete all rows from Supabase public.sms_prospect (keeps table + columns).
 *
 *   node scripts/wipe-supabase-prospects.mjs
 *   node scripts/wipe-supabase-prospects.mjs --all
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from '@supabase/supabase-js';

const all = process.argv.includes('--all') || process.argv.includes('-a');
if (!all) {
  console.error('Refusing to run without --all (safety). Example: node scripts/wipe-supabase-prospects.mjs --all');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
const chunk = 500;
let total = 0;
for (;;) {
  const { data, error: selErr } = await sb.from('sms_prospect').select('id').limit(chunk);
  if (selErr) throw selErr;
  const ids = (data || []).map((r) => r.id);
  if (!ids.length) break;
  const { error: delErr } = await sb.from('sms_prospect').delete().in('id', ids);
  if (delErr) throw delErr;
  total += ids.length;
  process.stdout.write(`\rDeleted ${total} rows…`);
}
console.log(`\nDone. sms_prospect is empty (${total} rows removed).`);
