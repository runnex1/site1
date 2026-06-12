const { runDueJobs } = require('../../lib/cron-runner');

function allowedSecret() {
  return process.env.SYNC_SECRET1 || process.env.SYNC_SECRET || '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret, authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const expected = allowedSecret();
  const provided = String(
    req.headers['x-sync-secret']
    || req.query?.secret
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || '',
  );
  if (!expected || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const maxJobs = Math.min(2, Math.max(1, parseInt(req.query?.maxJobs || '2', 10) || 2));
  try {
    const result = await runDueJobs({ maxJobs });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Cron tick failed' });
  }
};
