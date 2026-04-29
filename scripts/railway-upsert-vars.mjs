#!/usr/bin/env node
/**
 * Upsert Railway environment variables via GraphQL (account token in RAILWAY_TOKEN).
 * Usage: RAILWAY_TOKEN=... node scripts/railway-upsert-vars.mjs < secrets.json
 * secrets.json: { "OPENAI_API_KEY": "...", ... }
 */
import fs from 'fs';

const token = process.env.RAILWAY_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const serviceId = process.env.RAILWAY_SERVICE_ID;

if (!token || !projectId || !environmentId || !serviceId) {
  console.error('Missing RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, or RAILWAY_SERVICE_ID');
  process.exit(1);
}

const raw = fs.readFileSync(0, 'utf8');
const vars = JSON.parse(raw);

const mutation = `
mutation Upsert($input: VariableUpsertInput!) {
  variableUpsert(input: $input)
}
`;

async function upsert(name, value) {
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
          skipDeploys: false,
        },
      },
    }),
  });
  const j = await res.json();
  if (j.errors?.length) {
    console.error(name, j.errors);
    throw new Error(j.errors[0].message);
  }
  console.log('OK', name);
}

for (const [name, value] of Object.entries(vars)) {
  if (value == null || value === '') continue;
  await upsert(name, value);
}
