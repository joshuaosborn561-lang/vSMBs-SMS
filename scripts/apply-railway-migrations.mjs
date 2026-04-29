#!/usr/bin/env node
/**
 * Fetches Postgres DATABASE_PUBLIC_URL from Railway GraphQL, runs migrations/*.sql in order.
 * Env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and POSTGRES_SERVICE_ID (default: b5ff0c23-b9b4-4e92-bbdc-a82e82d93e0e for vSMBs-SMS)
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const token = process.env.RAILWAY_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const postgresServiceId = process.env.POSTGRES_SERVICE_ID || 'b5ff0c23-b9b4-4e92-bbdc-a82e82d93e0e';

if (!token || !projectId || !environmentId) {
  console.error('Missing RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID');
  process.exit(1);
}

const gql = async (query, variables) => {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
};

const data = await gql(
  `query($e:String!, $p:String!, $s:String) {
    variables(environmentId: $e, projectId: $p, serviceId: $s)
  }`,
  { e: environmentId, p: projectId, s: postgresServiceId }
);

const raw =
  data.variables?.DATABASE_PUBLIC_URL ||
  data.variables?.DATABASE_URL ||
  '';
if (!raw) throw new Error('No DATABASE_PUBLIC_URL on Postgres service');

const dir = path.join(__dirname, '..', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({
  connectionString: raw,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
console.log('[migrations] connected (public proxy)');
for (const f of files) {
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  console.log('[migrations] applying', f);
  await client.query(sql);
}
await client.end();
console.log('[migrations] ok', files.length, 'files');
