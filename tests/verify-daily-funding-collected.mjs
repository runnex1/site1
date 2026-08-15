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
const { buildDailyFundingSeries, fundingDayKeyForMs } = require('../lib/perps.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = process.argv[2] || join(ROOT, '_perps-verify-funding.json');
if (!existsSync(dataPath)) {
  console.error('Missing perps JSON. Run: curl .../api/perps?wallet=... > _perps-verify-funding.json');
  process.exit(1);
}
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const days = Number(data.days) || 30;
const fetchedAt = Number(data.fetchedAt) || Date.now();

function sumPaymentsOnSeriesDays(payments, seriesRows) {
  const daySet = new Set((seriesRows || []).map(r => r.day));
  return (payments || []).reduce((s, p) => s + (daySet.has(fundingDayKeyForMs(p.time)) ? (p.usdc || 0) : 0), 0);
}

function sumFeesOnSeriesDays(items, seriesRows) {
  const daySet = new Set((seriesRows || []).map(r => r.day));
  return (items || []).reduce((s, f) => s + (daySet.has(fundingDayKeyForMs(f.time)) ? (f.fee || 0) : 0), 0);
}

function rebuildSeries() {
  return buildDailyFundingSeries({
    hlPayments: data.hyperliquid?.funding?.payments || [],
    nadoPayments: data.nado?.funding?.payments || [],
    grvtPayments: data.grvt?.funding?.payments || [],
    extendedPayments: data.extended?.funding?.payments || [],
    phoenixPayments: data.phoenix?.funding?.payments || [],
    hlFills: data.hyperliquid?.fills?.fills || [],
    nadoMatches: data.nado?.matches?.matches || [],
    grvtFills: data.grvt?.fills?.fills || [],
    extendedFills: data.extended?.fills?.fills || [],
    phoenixFills: data.phoenix?.fills?.fills || [],
    days,
    endMs: fetchedAt,
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
    phoenixPayments: data.phoenix?.funding?.payments || [],
    hlFills: data.hyperliquid?.fills?.fills || [],
    nadoMatches: data.nado?.matches?.matches || [],
    grvtFills: data.grvt?.fills?.fills || [],
    extendedFills: data.extended?.fills?.fills || [],
    phoenixFills: data.phoenix?.fills?.fills || [],
    days,
    endMs: fetchedAt,
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
  + sumPaymentsOnSeriesDays(data.extended?.funding?.payments, rebuilt)
  + sumPaymentsOnSeriesDays(data.phoenix?.funding?.payments, rebuilt);
const rawFees = sumFeesOnSeriesDays(data.hyperliquid?.fills?.fills, rebuilt)
  + sumFeesOnSeriesDays(data.nado?.matches?.matches, rebuilt)
  + sumFeesOnSeriesDays(data.grvt?.fills?.fills, rebuilt)
  + sumFeesOnSeriesDays(data.extended?.fills?.fills, rebuilt)
  + sumFeesOnSeriesDays(data.phoenix?.fills?.fills, rebuilt);

const eps = 0.02;
assert.ok(Math.abs(rebuiltSum.funding - rawFunding) < eps,
  `rebuilt funding ${rebuiltSum.funding} must match raw payments ${rawFunding}`);
assert.ok(serverSum.funding >= rebuiltSum.funding - eps,
  `server dailyFundingSeries funding ${serverSum.funding} must cover rebuild ${rebuiltSum.funding} (server builds from full payments; payload raw arrays are slimmed)`);
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
    + sumPaymentsOnSeriesDays(filterPaired(data.extended?.funding?.payments), rebuiltPaired)
    + sumPaymentsOnSeriesDays(filterPaired(data.phoenix?.funding?.payments), rebuiltPaired);
  assert.ok(Math.abs(pairedSum.funding - rawPaired) < eps,
    `paired funding ${pairedSum.funding} must match raw paired payments ${rawPaired}`);
  if (serverPaired.length) {
    assert.ok(Math.abs(sumSeries(serverPaired).funding - pairedSum.funding) < eps,
      `server pairedDailyFundingSeries must match rebuild`);
  }
  assert.ok(pairedSum.funding <= rebuiltSum.funding + eps,
    'paired funding must not exceed whole-wallet funding in same window');
}

// Bucharest day boundaries (DST-aware) for the filter helpers below.
const _partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function bucharestDayStartMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const noonUtc = Date.UTC(y, mo - 1, d, 12);
  const parts = _partsFmt.formatToParts(new Date(noonUtc));
  const wall = new Date(Date.UTC(
    Number(parts.find(p => p.type === 'year').value),
    Number(parts.find(p => p.type === 'month').value) - 1,
    Number(parts.find(p => p.type === 'day').value),
    Number(parts.find(p => p.type === 'hour').value),
    Number(parts.find(p => p.type === 'minute').value),
    Number(parts.find(p => p.type === 'second').value),
  ));
  return Date.UTC(y, mo - 1, d) - (wall.getTime() - noonUtc);
}

function bucharestDayEndMs(day) {
  const start = bucharestDayStartMs(day);
  if (start == null) return null;
  const next = fundingDayKeyForMs(start + 86400000);
  if (!next) return null;
  return bucharestDayStartMs(next) - 1;
}

const cutoff7d = fetchedAt - 7 * 86400000;
const raw7d = (data.hyperliquid?.funding?.payments || [])
  .concat(data.nado?.funding?.payments || [], data.grvt?.funding?.payments || [], data.extended?.funding?.payments || [], data.phoenix?.funding?.payments || [])
  .filter(p => Number(p.time) >= cutoff7d && Number(p.time) <= fetchedAt)
  .reduce((s, p) => s + (p.usdc || 0), 0);

// Mirror client perpsFilterDailySeries for 7d
function filter7d(series) {
  const rows = series.filter(r => bucharestDayEndMs(r.day || '') >= cutoff7d);
  const trimmed = rows.map((row) => {
    const fundingEvents = (row.fundingEvents || []).filter(e => (e.time || 0) >= cutoff7d);
    const feeEvents = (row.feeEvents || []).filter(e => (e.time || 0) >= cutoff7d);
    const dailyFunding = fundingEvents.reduce((s, e) => s + (e.usdc || 0), 0);
    const dailyFees = feeEvents.reduce((s, e) => s + (e.fee || 0), 0);
    return { ...row, dailyFunding, dailyFees, dailyNet: dailyFunding - dailyFees, fundingEvents, feeEvents };
  }).filter(r => r.fundingEvents?.length || r.feeEvents?.length || bucharestDayStartMs(r.day || '') >= cutoff7d);
  return trimmed;
}

const filtered7d = filter7d(server);
const filtered7dSum = sumSeries(filtered7d);
assert.ok(filtered7dSum.funding >= raw7d - eps,
  `7D filtered chart funding ${filtered7dSum.funding} must cover raw 7d payments ${raw7d} (server series includes inactive-symbol funding; payload raw arrays are slimmed)`);

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
