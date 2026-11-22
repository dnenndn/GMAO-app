require('dotenv').config();
const express = require('express');
const { idempotent } = require('./idempotency');
const cors = require('cors');

// Defense in depth: even with the per-route fixes, a single bad request
// should never take the whole backend down for every user. Log and keep
// running instead of letting Node's default "crash on unhandled rejection"
// behavior kill the process.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (backend kept running):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (backend kept running):', err);
});

const authRoutes = require('./routes/auth');
const articlesRoutes = require('./routes/articles');
const referenceDataRoutes = require('./routes/reference-data');
const bsmRoutes = require('./routes/bsm');
const receptionRoutes = require('./routes/reception');
const brmRoutes = require('./routes/brm');
const notificationsRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const feuillardRoutes = require('./routes/feuillard');
const feuillardMvtRoutes = require('./routes/feuillardMvt');
const movementsRoutes = require('./routes/movements');
const daRoutes = require('./routes/da');
const nfcRoutes = require('./routes/nfc');
const atelierRoutes = require('./routes/atelier');
const productionRoutes = require('./routes/production');
const carburantRoutes = require('./routes/carburant');
const maintenanceRoutes = require('./routes/maintenance');
const achatsRoutes = require('./routes/achats');
const stockInsightRoutes = require('./routes/stockinsight');
const dashboardRoutes = require('./routes/dashboard');
const { startFuelAlerts } = require('./fuelAlerts');
const { startDailyAlerts } = require('./alerts');
const parcRoutes = require('./routes/parc');
const { requireAuth } = require('./middleware/auth');
const { requireFeature, requireAny } = require('./features');
const daReviewRoutes = require('./routes/daReview');
const permissionsRoutes = require('./routes/permissions');
const { apiLimiter, securityHeaders, corsOptions, checkSecrets } = require('./security');

const app = express();

// Compress JSON responses (typically 5-10x smaller on the wire - the biggest
// single saving on mobile data). Optional: if the package is not installed
// yet (npm install not run), the server still starts, just uncompressed.
try {
  app.use(require('compression')());
} catch (e) {
  console.warn('compression package not installed - run "npm install" in backend/ to save mobile data.');
}

app.disable('x-powered-by');
checkSecrets();
app.use(securityHeaders);
app.use(cors(corsOptions()));
app.use('/api', apiLimiter());
app.use(express.json());

// /api/health = the web server answers; /api/health?deep=1 also checks both SQL databases
// (use the deep one for an external uptime monitor, see BACKEND_README.md).
app.get('/api/health', async (req, res) => {
  if (!req.query.deep) return res.json({ status: 'ok' });
  try {
    const { getPool } = require('./db'); const { getAppPool } = require('./appDb');
    await (await getPool()).request().query('select 1 as ok');
    await (await getAppPool()).request().query('select 1 as ok');
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    console.error('health check: database unreachable:', err.message);
    res.status(503).json({ status: 'down', db: 'unreachable' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/articles', requireAuth, requireAny(['stock.view', 'bsm.create', 'brm.create', 'da.create']), articlesRoutes);
app.use('/api/reference-data', referenceDataRoutes);
app.post(['/api/bsm', '/api/maintenance/di'], requireAuth, idempotent);
app.use('/api/bsm', bsmRoutes);
app.use('/api/reception', receptionRoutes);
app.use('/api/brm', brmRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/feuillard', feuillardRoutes);
app.use('/api/feuillard', feuillardMvtRoutes);
app.use('/api/movements', movementsRoutes);
app.use('/api/da', daRoutes);
app.use('/api/nfc', nfcRoutes);
app.use('/api/atelier', requireAuth, requireFeature('atelier.view'), atelierRoutes);
app.use('/api/production', requireAuth, requireFeature('production.view'), productionRoutes);
app.use('/api/carburant', requireAuth, requireFeature('parc.view'), carburantRoutes);
app.use('/api/parc', requireAuth, requireFeature('parc.view'), parcRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/da-review', daReviewRoutes);
app.use('/api/maintenance', requireAuth, requireAny(['maintenance.view', 'di.create']), maintenanceRoutes);
app.use('/api/achats', achatsRoutes);
app.use('/api/stock-insight', requireAuth, requireAny(['stock.insight', 'stock.valuation']), stockInsightRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`GMAO stock connector listening on port ${port}`);
  startFuelAlerts();
  startDailyAlerts();
});
