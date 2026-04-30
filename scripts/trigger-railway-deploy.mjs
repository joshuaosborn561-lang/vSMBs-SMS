#!/usr/bin/env node
/**
 * Trigger a new deployment for the app service (same as Dashboard → Deploy).
 * Env: RAILWAY_TOKEN, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID
 */
const token = process.env.RAILWAY_TOKEN;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const serviceId = process.env.RAILWAY_SERVICE_ID;
if (!token || !environmentId || !serviceId) {
  console.error('Missing RAILWAY_TOKEN, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID');
  process.exit(1);
}

const mutation = `mutation($e: String!, $s: String!) {
  serviceInstanceDeployV2(environmentId: $e, serviceId: $s)
}`;
const res = await fetch('https://backboard.railway.com/graphql/v2', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: mutation,
    variables: { e: environmentId, s: serviceId },
  }),
});
const j = await res.json();
if (j.errors?.length) {
  console.error(j.errors);
  process.exit(1);
}
console.log('deployment id:', j.data.serviceInstanceDeployV2);
