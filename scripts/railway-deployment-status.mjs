#!/usr/bin/env node
/**
 * Print latest deployment id + status for the linked app service.
 * Env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID
 *
 * Usage: node scripts/railway-deployment-status.mjs
 */
const token = process.env.RAILWAY_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const serviceId = process.env.RAILWAY_SERVICE_ID;
if (!token || !projectId || !serviceId) process.exit(1);

const q = `query($id: String!) {
  project(id: $id) {
    name
    services { edges { node { id name serviceInstances {
      edges { node {
        id
        latestDeployment { id status createdAt }
      } }
    } } } }
  }
}`;
const res = await fetch('https://backboard.railway.com/graphql/v2', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: q, variables: { id: projectId } }),
});
const j = await res.json();
if (j.errors?.length) {
  console.error(j.errors);
  process.exit(1);
}
const edges = j.data?.project?.services?.edges || [];
for (const e of edges) {
  const n = e.node;
  if (n.id !== serviceId) continue;
  const inst = n.serviceInstances?.edges?.[0]?.node;
  const dep = inst?.latestDeployment;
  console.log(JSON.stringify({ service: n.name, deployment: dep }, null, 2));
  process.exit(0);
}
console.log('service not found');
