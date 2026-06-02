/**
 * Focused regression checks for perps accounting and dashboard wiring.
 * Run: node tests/perps-regression.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  appendEquitySnapshotStore,
  buildDailyFundingSeries,
  computeCombinedNetDeposits,
} = require('../lib/perps.js');
const aaveProxyHandler = require('../api/aave-proxy.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const perpsJs = readFileSync(join(ROOT, 'lib', 'perps.js'), 'utf8');
const aaveProxyJs = readFileSync(join(ROOT, 'api', 'aave-proxy.js'), 'utf8');
const syncJs = readFileSync(join(ROOT, 'api', 'sync.js'), 'utf8');
const now = Date.now();

function payment(usdc, time = now) {
  return { kind: usdc > 0 ? 'deposit' : 'withdraw', usdc, time };
}

function combined(hlPayments, nadoPayments, grvtPayments = null) {
  return computeCombinedNetDeposits(
    { payments: hlPayments },
    { payments: nadoPayments },
    grvtPayments ? { payments: grvtPayments } : null,
  );
}

{
  const result = combined([payment(-100)], [payment(100)]);
  assert.equal(result.rawCombinedNetDeposits, 0);
  assert.equal(result.combinedNetDeposits, 0, 'cross-venue withdrawal and deposit must remain net zero');
}

{
  const result = combined([payment(100)], [payment(100)]);
  assert.equal(result.rawCombinedNetDeposits, 200);
  assert.equal(result.combinedNetDeposits, 100, 'duplicate same-direction deposits must be counted once');
}

{
  const result = combined([payment(-100)], [payment(-100)]);
  assert.equal(result.rawCombinedNetDeposits, -200);
  assert.equal(result.combinedNetDeposits, -100, 'duplicate same-direction withdrawals must be counted once');
}

{
  const result = combined([payment(100)], [payment(100)], [payment(100)]);
  assert.equal(result.combinedNetDeposits, 100, 'a deposit duplicated across three venues must be counted once');
}

{
  const recent = now - (23 * 60 * 60 * 1000);
  const old = now - (25 * 60 * 60 * 1000);
  const series = buildDailyFundingSeries({
    hlPayments: [{ symbol: 'BTC', time: recent, usdc: 2 }, { symbol: 'BTC', time: old, usdc: 3 }],
    hlFills: [{ symbol: 'BTC', time: recent, fee: 0.5 }, { symbol: 'BTC', time: old, fee: 1 }],
    days: 2,
  });
  const events = series.flatMap(row => row.fundingEvents);
  const fees = series.flatMap(row => row.feeEvents);
  assert.equal(events.length, 2, 'daily series must retain funding event timestamps');
  assert.equal(fees.length, 2, 'daily series must retain fee event timestamps');
}

assert.match(indexHtml, /perpsTrimDailyRowToCutoff\(r, cutoff\)/, 'daily rows must be trimmed to the exact cutoff');
assert.match(indexHtml, /return t >= cutoff;/, 'equity points must use the exact rolling cutoff');
assert.match(indexHtml, /perpsRenderAlerts\(data\.paired \|\| \[\], data\.unhedged \|\| \[\], data\.summary \|\| \{\}\);/, 'alerts must refresh with the dashboard');
assert.doesNotMatch(perpsJs, /positions\.reduce\(\(s, p\) => s \+ \(p\.notional \|\| 0\), 0\)/, 'Extended notional must not be used as equity');
assert.match(perpsJs, /funding: extendedFundingWindow,/, 'Extended response must expose selected-window funding');
assert.match(perpsJs, /fundingSinceOpen: extendedFundingSinceOpen,/, 'Extended response must preserve since-open funding separately');

{
  const dashboard = (fetchedAt, total, overrides = {}) => ({
    fetchedAt,
    equityNow: { hl: total - 100, nado: 100, grvt: 0, extended: 0 },
    summary: {
      hlAccountValue: total - 100,
      nadoAccountValue: 100,
      grvtConfigured: false,
      extendedConfigured: false,
      combinedNetDeposits: 0,
      adjustedEquity: total,
      equitySnapshotEligible: true,
      ...overrides,
    },
  });
  const first = appendEquitySnapshotStore({}, dashboard(Date.UTC(2026, 5, 2, 8, 5), 1000));
  const second = appendEquitySnapshotStore(first, dashboard(Date.UTC(2026, 5, 2, 11, 55), 1200));
  assert.equal(Object.keys(second).length, 1, 'same 4h bucket must contain only one snapshot');
  assert.equal(second['2026-06-02T08'].totalEquity, 1000, 'minute refreshes must not rewrite a 4h snapshot');

  const incomplete = appendEquitySnapshotStore(second, dashboard(Date.UTC(2026, 5, 2, 12, 5), 200, {
    equitySnapshotEligible: false,
    equitySnapshotIssue: 'GRVT equity unavailable',
  }));
  assert.equal(Object.keys(incomplete).length, 1, 'incomplete venue reads must not create equity snapshots');
}

assert.match(indexHtml, /if \(store\[bucket\]\) return;/, 'browser snapshots must be append-only within each 4h bucket');
assert.match(indexHtml, /if \(!perpsIsEquitySnapshotEligible\(data\)\) return;/, 'browser snapshots must reject incomplete reads');
assert.match(aaveProxyJs, /portfolio\?\.perpsArb/, 'cron snapshots must recover wallet config from the saved portfolio');
assert.match(aaveProxyJs, /kvSet\('vault:perps_config'/, 'cron snapshots must persist recovered wallet config');
assert.match(syncJs, /const savedConfig = parseJson\(await kvGet\('vault:perps_config'\), \{\}\);/, 'fast config endpoint must use the initialized parser');
assert.doesNotMatch(syncJs, /const perpsConfig = parse\(await kvGet\('vault:perps_config'\), \{\}\);/, 'fast config endpoint must not call a parser before initialization');

{
  let statusCode = null;
  let responseBody = null;
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return body;
    },
  };
  await aaveProxyHandler({ method: 'GET', headers: {}, query: { cronSnapshot: '1' } }, res);
  assert.equal(statusCode, 401, 'cron snapshot GET must reach the protected Perps handler without a wallet query');
  assert.equal(responseBody?.error, 'Unauthorized');
}

console.log('PASS: perps accounting and dashboard regression checks');
