#!/usr/bin/env node
/**
 * Production smoke check: loop snapshots should advance server-side without a browser visit.
 * Usage: node scripts/verify-loop-snapshots-cron.mjs [baseUrl]
 */
import https from 'node:https';

const BASE = (process.argv[2] || 'https://testedefi.vercel.app').replace(/\/+$/, '');

function getJson(path) {
  const url = `${BASE}${path}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body || '{}') });
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

function latestSnapshotMeta(store) {
  const entries = Object.entries(store || {});
  if (!entries.length) return { key: null, fetchedAt: 0, positions: 0 };
  entries.sort((a, b) => Number(a[1]?.fetchedAt || 0) - Number(b[1]?.fetchedAt || 0));
  const [key, rec] = entries[entries.length - 1];
  return {
    key,
    fetchedAt: Number(rec?.fetchedAt || 0),
    positions: Array.isArray(rec?.positions) ? rec.positions.length : 0,
  };
}

const checks = [];
function pass(name) { checks.push({ name, ok: true }); console.log(`PASS ${name}`); }
function fail(name, detail) { checks.push({ name, ok: false, detail }); console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }

const status = await getJson('/api/cron/status');
if (status.status !== 200) fail('cron status endpoint', `HTTP ${status.status}`);
else pass('cron status endpoint');

const loops = status.body?.jobs?.loopsSync;
if (!loops) fail('loopsSync job present');
else pass('loopsSync job present');

if (loops?.lastResult?.skipped && loops.lastResult.reason === 'no_yield_wallets') {
  fail('loopsSync has yield wallets', 'cron is skipping with no_yield_wallets');
} else {
  pass('loopsSync has yield wallets');
}

const snapRes = await getJson('/api/loop-snapshots');
if (snapRes.status !== 200) fail('loop snapshots endpoint', `HTTP ${snapRes.status}`);
else pass('loop snapshots endpoint');

const store = snapRes.body?.loopSnapshots || {};
const latest = latestSnapshotMeta(store);
const ageHours = latest.fetchedAt ? (Date.now() - latest.fetchedAt) / 3600000 : Infinity;
const cronLatest = Number(loops?.lastResult?.latestFetchedAt || loops?.lastResult?.fetchedAt || 0);

if (!latest.key) fail('loop snapshots store has buckets');
else pass(`loop snapshots store has buckets — latest=${latest.key}`);

if (ageHours > 6) {
  fail('latest loop snapshot is recent', `latest bucket ${latest.key} is ${ageHours.toFixed(1)}h old`);
} else {
  pass(`latest loop snapshot is recent — ${ageHours.toFixed(1)}h old`);
}

if (cronLatest && latest.fetchedAt && cronLatest > latest.fetchedAt + 60000) {
  fail('cron result matches KV snapshot store', `cron latest ${cronLatest} > store ${latest.fetchedAt}`);
} else if (loops?.lastSuccess && latest.fetchedAt) {
  pass('cron result matches KV snapshot store');
}

if (latest.positions < 1) fail('latest bucket has positions');
else pass(`latest bucket has positions — count=${latest.positions}`);

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} production loop snapshot check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} production loop snapshot checks passed.`);
