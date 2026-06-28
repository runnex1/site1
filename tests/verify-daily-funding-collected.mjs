/**
 * Verify Daily Funding Collected chart data matches raw exchange payment history.
 * Run: node tests/verify-daily-funding-collected.mjs [path-to-perps-json]
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildDailyFundingSeries } = require('../lib/perps.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = process.argv[2] || join(ROOT, '_perps-verify-funding.json');
if (!existsSync(dataPath)) {
  console.error('Missing perps JSON. Run: curl .../api/perps?wallet=... > _perps-verify-funding.json');
  process.exit(1);
}
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const days = Number(data.days) || 30;

function sumPaymentsOnSeriesDays(payments, seriesRows) {
  const daySet = new Set((seriesRows || []).map(r => r.day));
  const isoDateFromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
  return (payments || []).reduce((s, p) => s + (daySet.has(isoDateFromMs(p.time)) ? (p.usdc || 0) : 0), 0);
}

function sumFeesOnSeriesDays(items, seriesRows) {
  const daySet = new Set((seriesRows || []).map(r => r.day));
  const isoDateFromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
  return (items || []).reduce((s, f) => s + (daySet.has(isoDateFromMs(f.time)) ? (f.fee || 0) : 0), 0);
}

function rebuildSeries() {
  return buildDailyFundingSeries({
    hlPayments: data.hyperliquid?.funding?.payments || [],
    nadoPayments: data.nado?.funding?.payments || [],
    grvtPayments: data.grvt?.funding?.payments || [],
    extendedPayments: data.extended?.funding?.payments || [],
    hlFills: data.hyperliquid?.fills?.fills || [],
    nadoMatches: data.nado?.matches?.matches || [],
    grvtFills: data.grvt?.fills?.fills || [],
    extendedFills: data.extended?.fills?.fills || [],
    days,
  });
}

function sumSeries(rows, useNet = false) {
  let funding = 0;
  let fees = 0;
  for (const row of rows || []) {
    funding += row.dailyFunding || 0;
    fees += row.dailyFees || 0;
  }
  return { funding, fees, net: funding - fees, total: useNet ? funding - fees : funding };
}

const rebuilt = rebuildSeries();
const pairedBases = (data.paired || []).map(p => p.symbol);
const rebuiltPaired = pairedBases.length
  ? buildDailyFundingSeries({
    hlPayments: data.hyperliquid?.funding?.payments || [],
    nadoPayments: data.nado?.funding?.payments || [],
    grvtPayments: data.grvt?.funding?.payments || [],
    extendedPayments: data.extended?.funding?.payments || [],
    hlFills: data.hyperliquid?.fills?.fills || [],
    nadoMatches: data.nado?.matches?.matches || [],
    grvtFills: data.grvt?.fills?.fills || [],
    extendedFills: data.extended?.fills?.fills || [],
    days,
    pairedBases,
  })
  : rebuilt;
const server = data.dailyFundingSeries || [];
const serverPaired = data.pairedDailyFundingSeries || [];
const rebuiltSum = sumSeries(rebuilt);
const serverSum = sumSeries(server);

const rawFunding = sumPaymentsOnSeriesDays(data.hyperliquid?.funding?.payments, rebuilt)
  + sumPaymentsOnSeriesDays(data.nado?.funding?.payments, rebuilt)
  + sumPaymentsOnSeriesDays(data.grvt?.funding?.payments, rebuilt)
  + sumPaymentsOnSeriesDays(data.extended?.funding?.payments, rebuilt);
const rawFees = sumFeesOnSeriesDays(data.hyperliquid?.fills?.fills, rebuilt)
  + sumFeesOnSeriesDays(data.nado?.matches?.matches, rebuilt)
  + sumFeesOnSeriesDays(data.grvt?.fills?.fills, rebuilt)
  + sumFeesOnSeriesDays(data.extended?.fills?.fills, rebuilt);

const eps = 0.02;
assert.ok(Math.abs(rebuiltSum.funding - rawFunding) < eps,
  `rebuilt funding ${rebuiltSum.funding} must match raw payments ${rawFunding}`);
assert.ok(Math.abs(serverSum.funding - rebuiltSum.funding) < eps,
  `server dailyFundingSeries funding ${serverSum.funding} must match rebuild ${rebuiltSum.funding}`);
assert.ok(Math.abs(rebuiltSum.fees - rawFees) < eps,
  `rebuilt fees ${rebuiltSum.fees} must match raw fills ${rawFees}`);

if (pairedBases.length) {
  const pairedSum = sumSeries(rebuiltPaired);
  const toBase = s => String(s || '').toUpperCase().replace(/-PERP$/i, '');
  const daySet = new Set(rebuiltPaired.map(r => r.day));
  const filterPaired = arr => (arr || []).filter(p => pairedBases.includes(toBase(p.symbol)));
  const rawPaired = sumPaymentsOnSeriesDays(filterPaired(data.hyperliquid?.funding?.payments), rebuiltPaired)
    + sumPaymentsOnSeriesDays(filterPaired(data.nado?.funding?.payments), rebuiltPaired)
    + sumPaymentsOnSeriesDays(filterPaired(data.grvt?.funding?.payments), rebuiltPaired)
    + sumPaymentsOnSeriesDays(filterPaired(data.extended?.funding?.payments), rebuiltPaired);
  assert.ok(Math.abs(pairedSum.funding - rawPaired) < eps,
    `paired funding ${pairedSum.funding} must match raw paired payments ${rawPaired}`);
  if (serverPaired.length) {
    assert.ok(Math.abs(sumSeries(serverPaired).funding - pairedSum.funding) < eps,
      `server pairedDailyFundingSeries must match rebuild`);
  }
  assert.ok(pairedSum.funding <= rebuiltSum.funding + eps,
    'paired funding must not exceed whole-wallet funding in same window');
}

const cutoff7d = Date.now() - 7 * 86400000;
const raw7d = (data.hyperliquid?.funding?.payments || [])
  .concat(data.nado?.funding?.payments || [], data.grvt?.funding?.payments || [], data.extended?.funding?.payments || [])
  .filter(p => Number(p.time) >= cutoff7d)
  .reduce((s, p) => s + (p.usdc || 0), 0);

// Mirror client perpsFilterDailySeries for 7d
function filter7d(series) {
  const rows = series.filter(r => new Date(r.day + 'T23:59:59.999Z').getTime() >= cutoff7d);
  const trimmed = rows.map((row) => {
    const fundingEvents = (row.fundingEvents || []).filter(e => (e.time || 0) >= cutoff7d);
    const feeEvents = (row.feeEvents || []).filter(e => (e.time || 0) >= cutoff7d);
    const dailyFunding = fundingEvents.reduce((s, e) => s + (e.usdc || 0), 0);
    const dailyFees = feeEvents.reduce((s, e) => s + (e.fee || 0), 0);
    return { ...row, dailyFunding, dailyFees, dailyNet: dailyFunding - dailyFees, fundingEvents, feeEvents };
  }).filter(r => r.fundingEvents?.length || r.feeEvents?.length || new Date(r.day + 'T00:00:00Z').getTime() >= cutoff7d);
  return trimmed;
}

const filtered7d = filter7d(server);
const filtered7dSum = sumSeries(filtered7d);
assert.ok(Math.abs(filtered7dSum.funding - raw7d) < eps,
  `7D filtered chart funding ${filtered7dSum.funding} must match raw 7d payments ${raw7d}`);

const variationalPairs = (data.paired || []).filter(p => p.variationalHedgeId || String(p.pairType || '').includes('variational'));
const hasVariational = variationalPairs.length > 0;

console.log('verify-daily-funding-collected.mjs: PASS');
console.log(JSON.stringify({
  days,
  paired: (data.paired || []).map(p => p.symbol),
  variationalPairs: variationalPairs.map(p => p.symbol),
  exchangeOnly: {
    rawFundingTotal: +rawFunding.toFixed(2),
    rawFeesTotal: +rawFees.toFixed(2),
    serverSeriesFunding: +serverSum.funding.toFixed(2),
    serverSeriesFees: +serverSum.fees.toFixed(2),
    rebuiltFunding: +rebuiltSum.funding.toFixed(2),
    pairedFunding: pairedBases.length ? +sumSeries(rebuiltPaired).funding.toFixed(2) : null,
    serverPairedFunding: serverPaired.length ? +sumSeries(serverPaired).funding.toFixed(2) : null,
  },
  window7d: {
    rawFunding: +raw7d.toFixed(2),
    chartFunding: +filtered7dSum.funding.toFixed(2),
  },
  variationalOnChart: hasVariational
    ? 'open variational pairs add ~estimated funding client-side after fetch (not in server JSON above)'
    : 'none open — chart is exchange payment history only',
}, null, 2));
