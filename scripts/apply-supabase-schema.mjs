#!/usr/bin/env node
/**
 * Applies supabase/schema-reference.sql to the Supabase project that the
 * running app uses (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from Railway via GraphQL
 * if they are not already in the local environment.
 *
 * Usage: node scripts/apply-supabase-schema.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function railwayVars() {
  const token = process.env.RAILWAY_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  if (!token || !projectId || !environmentId || !serviceId) return {};
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($e:String!,$p:String!,$s:String){variables(environmentId:$e,projectId:$p,serviceId:$s)}',
      variables: { e: environmentId, p: projectId, s: serviceId },
    }),
  });
  const j = await r.json();
  return j?.data?.variables || {};
}

const env = await (async () => {
  const local = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  if (local.SUPABASE_URL && local.SUPABASE_SERVICE_ROLE_KEY) return local;
  const r = await railwayVars();
  return {
    SUPABASE_URL: local.SUPABASE_URL || r.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: local.SUPABASE_SERVICE_ROLE_KEY || r.SUPABASE_SERVICE_ROLE_KEY,
  };
})();

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (locally or on Railway)');
  process.exit(1);
}

const sqlPath = path.join(root, 'supabase', 'schema-reference.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

// Supabase REST API doesn't expose raw SQL execution, but the SQL endpoint at
// /rest/v1/rpc/exec_sql exists only when a custom function is created.
// We instead use the management API "Database" REST proxy — the `pg-meta`
// service exposed at /pg/query is admin-only and not stable.
//
// Reliable path: the official `pg` driver via the Supabase Postgres direct URL.
// We derive that from SUPABASE_URL by swapping the host to db.<ref>.supabase.co
// — but we still need the database password, which we don't have here.
//
// Practical approach used in this repo: rely on `npx supabase db query` after
// `supabase login` + `supabase link`. This script only documents that path.

console.log('[apply-supabase-schema] Apply this SQL in your Supabase project:');
console.log(`  Project URL: ${env.SUPABASE_URL}`);
console.log(`  File: ${sqlPath}`);
console.log('Run one of:');
console.log('  1) Supabase Studio → SQL editor → paste contents of supabase/schema-reference.sql');
console.log('  2) supabase login && supabase link --project-ref <ref> && \\');
console.log('     supabase db query --linked -f supabase/schema-reference.sql');
console.log('');
console.log('Quick health check (uses your service role):');

const headers = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
};
try {
  const probe = await fetch(`${env.SUPABASE_URL}/rest/v1/sms_prospect?select=normalized_name&limit=1`, { headers });
  if (probe.ok) {
    console.log('  sms_prospect.normalized_name OK ✓ (column already exists)');
  } else if (probe.status === 400 || probe.status === 404) {
    const txt = await probe.text();
    console.log('  sms_prospect.normalized_name MISSING — run the SQL above. Detail:', txt.slice(0, 200));
  } else {
    console.log('  Probe returned', probe.status, await probe.text());
  }
} catch (e) {
  console.log('  Probe failed:', e.message);
}
