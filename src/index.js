const path = require('path');
const express = require('express');

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection', reason);
});
const webhookRoutes = require('./routes/webhooks');
const slackRoutes = require('./routes/slack');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const testWebhookRoutes = require('./routes/test-webhooks');
const smsDashboardRoutes = require('./routes/sms-dashboard');
const smsCampaignAdminRoutes = require('./routes/sms-campaign-admin');
const { startCron } = require('./cron');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ─── Body parsing ────────────────────────────────────────────────────
// Capture raw body for Slack signature verification
app.use('/slack', express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

// JSON for everything else
app.use(express.json());

// ─── Dashboard UI ────────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/dashboard'));

// ─── Health check ────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Routes ──────────────────────────────────────────────────────────
app.use(webhookRoutes);
app.use(slackRoutes);
app.use(adminRoutes);
app.use(smsDashboardRoutes);
app.use(smsCampaignAdminRoutes);
app.use(authRoutes);
app.use(testWebhookRoutes);

// ─── Start ───────────────────────────────────────────────────────────
const port = Number(PORT) || 3000;
const listenHost = process.env.LISTEN_HOST || '0.0.0.0';
app.listen(port, listenHost, () => {
  console.log(`[Server] ReplyHandler listening on ${listenHost}:${port}`);
  setImmediate(() => {
    try {
      startCron();
    } catch (err) {
      console.error('[Cron] failed to start', err);
    }
  });
});
