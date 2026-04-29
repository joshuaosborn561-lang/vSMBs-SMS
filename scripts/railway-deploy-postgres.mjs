#!/usr/bin/env node
/**
 * Deploy Railway postgres template into an existing project.
 * Env: RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_WORKSPACE_ID
 */
const token = process.env.RAILWAY_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const workspaceId = process.env.RAILWAY_WORKSPACE_ID;
if (!token || !projectId || !environmentId || !workspaceId) {
  console.error('Missing RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, or RAILWAY_WORKSPACE_ID');
  process.exit(1);
}

const gql = async (query, variables) => {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors?.length) throw new Error(JSON.stringify(j.errors));
  return j.data;
};

const t = await gql(`query { template(code: "postgres") { id serializedConfig } }`, {});
const templateId = t.template.id;
const serializedConfig = t.template.serializedConfig;

const m = await gql(
  `mutation ($input: TemplateDeployV2Input!) {
    templateDeployV2(input: $input) { __typename projectId workflowId }
  }`,
  {
    input: {
      templateId,
      serializedConfig,
      projectId,
      environmentId,
      workspaceId,
    },
  }
);
console.log(JSON.stringify(m.templateDeployV2, null, 2));
