const { getCronStatus } = require('../../lib/cron-runner');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    return res.status(200).json(await getCronStatus());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Cron status failed' });
  }
};
