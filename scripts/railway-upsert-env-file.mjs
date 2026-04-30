#!/usr/bin/env node
/**
 * Upsert Railway variables from a dotenv-style file (KEY=value).
 * Lines starting with # are ignored. Values can be quoted with "...".
 *
 * Usage:
 *   RAILWAY_TOKEN=... node scripts/railway-upsert-env-file.mjs path/to/secrets.env
 *   cat secrets.env | node scripts/railway-upsert-env-file.mjs
 *
 * Env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID
 * Optional: SKIP_DEPLOY=true to avoid triggering a deploy after each variable
 */
import fs from 'fs';

const token = process.env.RAILWAY_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const serviceId = process.env.RAILWAY_SERVICE_ID;
const skipDeploys = process.env.SKIP_DEPLOY === 'true' || process.env.SKIP_DEPLOY === '1';

if (!token || !projectId || !environmentId || !serviceId) {
  console.error('Missing RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID');
  process.exit(1);
}

function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\n/g, '\n');
    } else val = val.trim();
    if (!key) continue;
    out[key] = val;
  }
  return out;
}

let raw;
if (process.argv[2]) {
  raw = fs.readFileSync(process.argv[2], 'utf8');
} else {
  raw = fs.readFileSync(0, 'utf8');
}

const vars = parseDotenv(raw);
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
  if (j.errors?.length) {
    console.error(name, j.errors);
    process.exit(1);
  }
  console.log('OK', name);
}
