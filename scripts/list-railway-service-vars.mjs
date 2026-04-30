#!/usr/bin/env node
/**
 * List variable NAMES on the Railway app service (values redacted).
 * Env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID
 */
const token = process.env.RAILWAY_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const serviceId = process.env.RAILWAY_SERVICE_ID;
if (!token || !projectId || !environmentId || !serviceId) {
  console.error('Missing RAILWAY_* env');
  process.exit(1);
}

const q = `query($e:String!, $p:String!, $s:String) {
  variables(environmentId: $e, projectId: $p, serviceId: $s)
}`;

const res = await fetch('https://backboard.railway.com/graphql/v2', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: q, variables: { e: environmentId, p: projectId, s: serviceId } }),
});
const j = await res.json();
if (j.errors?.length) {
  console.error(j.errors);
  process.exit(1);
}
const vars = j.data.variables || {};
const keys = Object.keys(vars).sort();
for (const k of keys) {
  const v = vars[k];
  const preview =
    v == null || v === ''
      ? '(empty)'
      : typeof v === 'string' && v.length > 12
        ? `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`
        : String(v);
  console.log(`${k}\t${preview}`);
}
