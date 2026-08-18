const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Helper to adapt Vercel serverless handlers
function adaptHandler(modulePath, extraQuery = {}) {
  return async (req, res) => {
    try {
      const mod = require(modulePath);
      const handler = mod.default || mod;
      if (Object.keys(extraQuery).length > 0) {
        req.query = { ...req.query, ...extraQuery };
      }
      await handler(req, res);
    } catch (err) {
      console.error(`Error in ${modulePath}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Internal Server Error' });
      }
    }
  };
}

// Rewrites from vercel.json
app.all('/api/perps', adaptHandler('./api/aave-proxy'));
app.all('/api/loop-rates', adaptHandler('./api/aave-proxy', { loopRates: '1' }));
app.all('/api/loop-snapshots', adaptHandler('./api/aave-proxy', { loopSnapshots: '1' }));
app.all('/api/loop-cron-snapshot', adaptHandler('./api/aave-proxy', { loopCronSnapshot: '1' }));
app.all('/api/pm-proxy', adaptHandler('./api/sync', { pmProxy: '1' }));
app.all('/api/cron/tick', adaptHandler('./api/sync', { cronTick: '1' }));
app.all('/api/cron/status', adaptHandler('./api/sync', { cronStatus: '1' }));
app.all('/api/check-alerts', adaptHandler('./api/sync', { checkAlerts: '1' }));

// Standard endpoints
app.all('/api/aave-proxy', adaptHandler('./api/aave-proxy'));
app.all('/api/ai', adaptHandler('./api/ai'));
app.all('/api/ask', adaptHandler('./api/ask'));
app.all('/api/etf-update', adaptHandler('./api/etf-update'));
app.all('/api/news', adaptHandler('./api/news'));
app.all('/api/prices', adaptHandler('./api/prices'));
app.all('/api/sync-alerts', adaptHandler('./api/sync-alerts'));
app.all('/api/sync', adaptHandler('./api/sync'));
app.all('/api/tg-webhook', adaptHandler('./api/tg-webhook'));
app.all('/api/tweets', adaptHandler('./api/tweets'));
app.all('/api/yahoo', adaptHandler('./api/yahoo'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/lib', express.static(path.join(__dirname, 'lib')));
app.use('/ui-previews', express.static(path.join(__dirname, 'ui-previews')));

// Serve index.html or fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Vault Portfolio server running on http://${HOST}:${PORT}`);
});
