#!/usr/bin/env node
/**
 * Create a dedicated Supabase project (separate from CRM), apply supabase/schema-reference.sql,
 * upsert SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on Railway (GraphQL — same token as migrations).
 *
 * Requires: `npx supabase login`, openssl.
 * Env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID
 * Optional: SUPABASE_ORG_ID, SUPABASE_REGION (default us-east-2), SUPABASE_PROJECT_NAME
 * Optional: SKIP_DEPLOY=true — pass skipDeploys on Railway variable upserts (default triggers deploy)
 *
 * Usage: node scripts/provision-reply-handler-supabase.mjs
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function runSupabase(args) {
  const r = spawnSync('npx', ['supabase', ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error(`supabase ${args.join(' ')} failed`);
  }
  return (r.stdout || '').trim();
}

function supabaseJson(args) {
  const out = runSupabase([...args, '-o', 'json']);
  return JSON.parse(out);
}

function randPw() {
  const r = spawnSync("openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 28", {
    shell: true,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('openssl failed');
  return (r.stdout || '').trim();
}

async function railwayUpsert(vars) {
  const token = process.env.RAILWAY_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const skipDeploys = process.env.SKIP_DEPLOY === 'true' || process.env.SKIP_DEPLOY === '1';
  if (!token || !projectId || !environmentId || !serviceId) {
    throw new Error('Missing RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID');
  }
  const mutation = `
mutation Upsert($input: VariableUpsertInput!) {
  variableUpsert(input: $input)
}`;
  for (const [name, value] of Object.entries(vars)) {
    if (value == null || value === '') continue;
    const res = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            projectId,
            environmentId,
            serviceId,
            name,
            value: String(value),
            skipDeploys,
          },
        },
      }),
    });
    const j = await res.json();
    if (j.errors?.length) throw new Error(`${name}: ${j.errors[0].message}`);
    console.log('Railway OK', name);
  }
}

const orgId = process.env.SUPABASE_ORG_ID || supabaseJson(['orgs', 'list'])[0]?.id;
if (!orgId) throw new Error('No Supabase org — set SUPABASE_ORG_ID');

const region = process.env.SUPABASE_REGION || 'us-east-2';
const name = process.env.SUPABASE_PROJECT_NAME || `Reply Handler SMS ${new Date().toISOString().slice(0, 10)}`;
const dbPassword = randPw();

console.log('[provision] Creating Supabase project:', name, region);
const created = supabaseJson([
  'projects',
  'create',
  name,
  '--org-id',
  orgId,
  '--db-password',
  dbPassword,
  '--region',
  region,
]);
const ref = created.ref || created.id;
if (!ref) throw new Error('No project ref in create response');

console.log('[provision] Linking', ref);
runSupabase(['link', '--project-ref', ref, '--yes']);

const sqlPath = path.join(root, 'supabase', 'schema-reference.sql');
if (!fs.existsSync(sqlPath)) throw new Error('Missing supabase/schema-reference.sql');

console.log('[provision] Applying schema');
runSupabase(['db', 'query', '--linked', '-f', 'supabase/schema-reference.sql', '--agent=no']);

const keys = supabaseJson(['projects', 'api-keys', '--project-ref', ref]);
const serviceRole = keys.find((k) => k.id === 'service_role')?.api_key;
if (!serviceRole) throw new Error('Could not find legacy service_role API key');

const supabaseUrl = `https://${ref}.supabase.co`;

console.log('[provision] Upserting Railway variables');
await railwayUpsert({
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: serviceRole,
});

console.log('[provision] Done.');
console.log('  Project:', name);
console.log('  Ref:', ref);
console.log('  Dashboard:', `https://supabase.com/dashboard/project/${ref}`);
console.log('  SUPABASE_URL:', supabaseUrl);
