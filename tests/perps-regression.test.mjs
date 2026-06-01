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
const { buildDailyFundingSeries, computeCombinedNetDeposits } = require('../lib/perps.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const perpsJs = readFileSync(join(ROOT, 'lib', 'perps.js'), 'utf8');
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

console.log('PASS: perps accounting and dashboard regression checks');
