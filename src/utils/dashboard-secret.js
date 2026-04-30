/**
 * Dashboard mutation endpoints (SMS builder, test send) optionally check a secret.
 * - If DASHBOARD_ACTION_SECRET is set: requests must send matching x-dashboard-secret.
 * - Otherwise: allowed without a PIN (same-origin dashboard).
 * WEBHOOK_TEST_SECRET alone does not gate these routes (so Slack test tooling doesn't force a "campaign PIN").
 */
function dashboardSecretOk(req) {
  const strict = (process.env.DASHBOARD_ACTION_SECRET || '').trim();
  if (!strict) return true;
  const got = (
    req.headers['x-dashboard-secret'] ||
    req.headers['x-webhook-test-secret'] ||
    ''
  ).trim();
  return got === strict;
}

module.exports = { dashboardSecretOk };
