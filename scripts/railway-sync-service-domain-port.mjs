#!/usr/bin/env node
/**
 * Align Railway **public domain target port** with the port your Node process listens on.
 *
 * Railway docs:
 * - https://docs.railway.com/guides/fixing-common-errors — 502 when edge cannot reach app;
 *   common causes include wrong **target port** vs listen port.
 * - https://docs.railway.com/networking/domains/working-with-domains#target-ports — domains map to an internal port.
 *
 * `variables()` / `variablesForServiceDeployment()` GraphQL often **omit** `PORT` (it is injected at runtime),
 * so do not infer listen port from those queries.
 *
 * Usage:
 *   node scripts/railway-sync-service-domain-port.mjs [listenPort]
 *   LISTEN_PORT=8080 node scripts/railway-sync-service-domain-port.mjs
 *
 * Default listenPort: 8080 (common Railway/Nixpacks Node default when PORT is injected at runtime).
 *
 * Env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID
 */
const token = process.env.RAILWAY_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const serviceId = process.env.RAILWAY_SERVICE_ID;
if (!token || !projectId || !environmentId || !serviceId) {
  console.error('Missing RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID');
  process.exit(1);
}

const fromArg = process.argv[2] ? parseInt(process.argv[2], 10) : NaN;
const fromEnv = process.env.LISTEN_PORT ? parseInt(process.env.LISTEN_PORT, 10) : NaN;
const targetPort = Number.isFinite(fromArg)
  ? fromArg
  : Number.isFinite(fromEnv)
    ? fromEnv
    : 8080;

if (!Number.isFinite(targetPort) || targetPort <= 0) {
  console.error('Invalid port; pass a number as argv or set LISTEN_PORT');
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}

const { domains } = await gql(
  `query($p:String!, $e:String!, $s:String!) {
    domains(projectId: $p, environmentId: $e, serviceId: $s) {
      serviceDomains { id domain targetPort }
    }
  }`,
  { p: projectId, e: environmentId, s: serviceId }
);

const list = domains?.serviceDomains || [];
if (!list.length) {
  console.log('No service domains found.');
  process.exit(0);
}

console.log(`Using listen port ${targetPort} (set LISTEN_PORT or pass as argv to override)`);

for (const d of list) {
  if (d.targetPort === targetPort) {
    console.log('OK', d.domain, 'already targetPort', targetPort);
    continue;
  }
  await gql(
    `mutation($input: ServiceDomainUpdateInput!) {
      serviceDomainUpdate(input: $input)
    }`,
    {
      input: {
        serviceDomainId: d.id,
        domain: d.domain,
        environmentId,
        serviceId,
        targetPort,
      },
    }
  );
  console.log('Updated', d.domain, d.targetPort, '->', targetPort);
}
