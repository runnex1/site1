/**
 * Daily Funding Collected — series invariants and filter semantics.
 * Run: node tests/daily-funding-series.test.mjs [path-to-perps-json]
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildDailyFundingSeries, fundingDayKeyForMs } = require('../lib/perps.js');
const VH = require('../lib/variational-hedge.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = process.argv[2] || join(ROOT, '_perps-verify-funding.json');

// Bucharest day-start (DST-aware): the offset is the difference between the
// Bucharest wall clock at noon-UTC (as a UTC instant) and noon-UTC itself.
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

function sumSeries(rows, useNet = false) {
  let funding = 0;
  let fees = 0;
  for (const row of rows || []) {
    funding += row.dailyFunding || 0;
    fees += row.dailyFees || 0;
  }
  return { funding, fees, net: funding - fees, total: useNet ? funding - fees : funding };
}

function assertRowEventConsistency(rows, label) {
  for (const row of rows || []) {
    const fromEvents = (row.fundingEvents || []).reduce((s, e) => s + (e.usdc || 0), 0);
    const fromFees = (row.feeEvents || []).reduce((s, e) => s + (e.fee || 0), 0);
    assert.ok(Math.abs((row.dailyFunding || 0) - fromEvents) < 1e-6,
      `${label} ${row.day}: dailyFunding ${row.dailyFunding} != events ${fromEvents}`);
    assert.ok(Math.abs((row.dailyFees || 0) - fromFees) < 1e-6,
      `${label} ${row.day}: dailyFees ${row.dailyFees} != fee events ${fromFees}`);
    const venueSum = Object.values(row.byVenue || {}).reduce((s, v) => s + (v || 0), 0);
    assert.ok(Math.abs((row.dailyFunding || 0) - venueSum) < 1e-6,
      `${label} ${row.day}: dailyFunding ${row.dailyFunding} != byVenue ${venueSum}`);
  }
}

function sumPaymentsOnDays(payments, daySet) {
  return (payments || []).reduce((s, p) => {
    const day = fundingDayKeyForMs(p.time);
    return s + (daySet.has(day) ? (p.usdc || 0) : 0);
  }, 0);
}

function filterDailySeries(series, rangeMs, nowMs = Date.now()) {
  if (!rangeMs) return series;
  const cutoff = Number(nowMs) - rangeMs;
  const eventsComplete = (row) => {
    const hasF = Array.isArray(row?.fundingEvents);
    const hasFee = Array.isArray(row?.feeEvents);
    if (!hasF && !hasFee) return false;
    const eps = 0.05;
    const funding = Number(row?.dailyFunding) || 0;
    const fees = Number(row?.dailyFees) || 0;
    if (hasF) {
      const fromEvents = row.fundingEvents.reduce((s, e) => s + (e.usdc || 0), 0);
      if (Math.abs(fromEvents - funding) > Math.max(eps, Math.abs(funding) * 1e-6)) return false;
    } else if (Math.abs(funding) > eps) return false;
    if (hasFee) {
      const fromEvents = row.feeEvents.reduce((s, e) => s + (e.fee || 0), 0);
      if (Math.abs(fromEvents - fees) > Math.max(eps, Math.abs(fees) * 1e-6)) return false;
    } else if (Math.abs(fees) > eps) return false;
    return true;
  };
  return series
    .filter(r => bucharestDayEndMs(r.day || '') >= cutoff)
    .map((row) => {
      const dayStart = bucharestDayStartMs(row.day || '');
      if (!eventsComplete(row)) {
        if (Number.isFinite(dayStart) && dayStart < cutoff) return null;
        return row;
      }
      const fundingEvents = Array.isArray(row.fundingEvents) ? row.fundingEvents.filter(e => (e.time || 0) >= cutoff) : [];
      const feeEvents = Array.isArray(row.feeEvents) ? row.feeEvents.filter(e => (e.time || 0) >= cutoff) : [];
      if (!fundingEvents.length && !feeEvents.length && Number.isFinite(dayStart) && dayStart < cutoff) return null;
      const dailyFunding = fundingEvents.reduce((s, e) => s + (e.usdc || 0), 0);
      const dailyFees = feeEvents.reduce((s, e) => s + (e.fee || 0), 0);
      const byVenue = {};
      fundingEvents.forEach(e => { byVenue[e.venue] = (byVenue[e.venue] || 0) + (e.usdc || 0); });
      return { ...row, dailyFunding, dailyFees, dailyNet: dailyFunding - dailyFees, byVenue, fundingEvents, feeEvents };
    })
    .filter(Boolean);
}

function mergeVariationalIntoSeries(baseRows, events) {
  const { startDay, endDay } = baseRows.length
    ? { startDay: baseRows[0].day, endDay: baseRows[baseRows.length - 1].day }
    : { startDay: null, endDay: null };
  const rows = baseRows.map(r => ({
    ...r,
    byVenue: { ...(r.byVenue || {}) },
    fundingEvents: [...(r.fundingEvents || [])],
    feeEvents: [...(r.feeEvents || [])],
  }));
  const byDay = new Map(rows.map(r => [r.day, r]));
  for (const ev of events) {
    const time = Number(ev.time) || 0;
    if (!time) continue;
    const day = fundingDayKeyForMs(time);
    if (startDay && day < startDay) continue;
    if (endDay && day > endDay) continue;
    let row = byDay.get(day);
    if (!row) {
      row = {
        day, dailyFunding: 0, dailyFees: 0, dailyNet: 0,
        byVenue: {}, fundingEvents: [], feeEvents: [],
      };
      byDay.set(day, row);
      rows.push(row);
    }
    const usdc = ev.usdc || 0;
    row.dailyFunding += usdc;
    row.dailyNet = row.dailyFunding - row.dailyFees;
    row.byVenue.variational = (row.byVenue.variational || 0) + usdc;
    row.fundingEvents.push({ ...ev, venue: 'variational', fundingEstimated: true });
  }
  rows.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return rows;
}

// --- Synthetic unit tests (no API file required) ---
{
  const now = Date.now();
  // Two consecutive Bucharest days, both fully in the past. Day A holds two
  // payments (+10, -3) one hour apart; Day B holds +5. This proves the series
  // buckets by Bucharest day (not UTC) and sums correctly per day.
  const dayA = fundingDayKeyForMs(now - 86400000);
  const dayB = fundingDayKeyForMs(now - 2 * 86400000);
  const aStart = bucharestDayStartMs(dayA);
  const bStart = bucharestDayStartMs(dayB);
  const payments = [
    { time: aStart + 4 * 3600000, usdc: 10, symbol: 'ETH', intervalHours: 1 },
    { time: aStart + 5 * 3600000, usdc: -3, symbol: 'ETH', intervalHours: 1 },
    { time: bStart + 4 * 3600000, usdc: 5, symbol: 'ETH', intervalHours: 1 },
  ];
  const series = buildDailyFundingSeries({ hlPayments: payments, days: 30 });
  assertRowEventConsistency(series, 'synthetic');
  const rowA = series.find(r => r.day === dayA);
  const rowB = series.find(r => r.day === dayB);
  assert.equal(rowA?.dailyFunding, 7);
  assert.equal(rowB?.dailyFunding, 5);
  const cutoff7d = Date.now() - 7 * 86400000;
  const raw7d = payments.filter(p => p.time >= cutoff7d).reduce((s, p) => s + p.usdc, 0);
  const filtered = filterDailySeries(series, 7 * 86400000);
  assert.ok(Math.abs(sumSeries(filtered).funding - raw7d) < 1e-6);
}

// --- Live / cached API payload ---
if (existsSync(dataPath)) {
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  const days = Number(data.days) || 30;
  const pairedBases = (data.paired || []).map(p => p.symbol);
  const inputs = {
    hlPayments: data.hyperliquid?.funding?.payments || [],
    nadoPayments: data.nado?.funding?.payments || [],
    grvtPayments: data.grvt?.funding?.payments || [],
    extendedPayments: data.extended?.funding?.payments || [],
    hlFills: data.hyperliquid?.fills?.fills || [],
    nadoMatches: data.nado?.matches?.matches || [],
    grvtFills: data.grvt?.fills?.fills || [],
    extendedFills: data.extended?.fills?.fills || [],
    days,
    endMs: Number(data.fetchedAt) || Date.now(),
  };

  const allWallet = buildDailyFundingSeries(inputs);
  const pairedOnly = pairedBases.length
    ? buildDailyFundingSeries({ ...inputs, pairedBases })
    : allWallet;

  assertRowEventConsistency(allWallet, 'all-wallet');
  assertRowEventConsistency(pairedOnly, 'paired-only');

  const daySet = new Set(allWallet.map(r => r.day));
  const rawAll = sumPaymentsOnDays(inputs.hlPayments, daySet)
    + sumPaymentsOnDays(inputs.nadoPayments, daySet)
    + sumPaymentsOnDays(inputs.grvtPayments, daySet)
    + sumPaymentsOnDays(inputs.extendedPayments, daySet);
  const eps = 0.02;
  assert.ok(Math.abs(sumSeries(allWallet).funding - rawAll) < eps,
    `all-wallet funding ${sumSeries(allWallet).funding} vs raw ${rawAll}`);

  if (pairedBases.length) {
    const pairedDaySet = new Set(pairedOnly.map(r => r.day));
    const toBase = s => String(s || '').toUpperCase().replace(/-PERP$/i, '');
    const filterPaired = arr => (arr || []).filter(p => pairedBases.includes(toBase(p.symbol)));
    const rawPaired = sumPaymentsOnDays(filterPaired(inputs.hlPayments), pairedDaySet)
      + sumPaymentsOnDays(filterPaired(inputs.nadoPayments), pairedDaySet)
      + sumPaymentsOnDays(filterPaired(inputs.grvtPayments), pairedDaySet)
      + sumPaymentsOnDays(filterPaired(inputs.extendedPayments), pairedDaySet);
    assert.ok(Math.abs(sumSeries(pairedOnly).funding - rawPaired) < eps,
      `paired funding ${sumSeries(pairedOnly).funding} vs raw ${rawPaired}`);
    assert.ok(sumSeries(pairedOnly).funding <= sumSeries(allWallet).funding + eps,
      'paired funding should not exceed whole-wallet funding');
  }

  const server = data.dailyFundingSeries || [];
  assert.ok(Math.abs(sumSeries(server).funding - sumSeries(allWallet).funding) < eps,
    `server dailyFundingSeries ${sumSeries(server).funding} vs rebuild ${sumSeries(allWallet).funding}`);

  if (data.pairedDailyFundingSeries?.length) {
    assert.ok(Math.abs(sumSeries(data.pairedDailyFundingSeries).funding - sumSeries(pairedOnly).funding) < eps,
      'API pairedDailyFundingSeries must match rebuild');
  }

  const cutoff7d = Number(data.fetchedAt || Date.now()) - 7 * 86400000;
  const raw7d = [...inputs.hlPayments, ...inputs.nadoPayments, ...inputs.grvtPayments, ...inputs.extendedPayments]
    .filter(p => Number(p.time) >= cutoff7d && Number(p.time) <= (Number(data.fetchedAt) || Date.now()))
    .reduce((s, p) => s + (p.usdc || 0), 0);
  const filtered7d = filterDailySeries(server, 7 * 86400000, Number(data.fetchedAt) || Date.now());
  assert.ok(Math.abs(sumSeries(filtered7d).funding - raw7d) < eps,
    `7D chart ${sumSeries(filtered7d).funding} vs raw ${raw7d}`);

  // Variational merge idempotency + window clip
  const varPair = (data.paired || []).find(p => p.variationalHedgeId || p.crossLegB?.venue === 'variational');
  if (varPair) {
    const listing = {
      markPx: 1,
      fundingRateInterval: 0.0001,
      fundingIntervalS: 14400,
      fundingIntervalHours: 4,
      fundingNextAtMs: Date.parse('2026-06-28T12:00:00.000Z'),
      fundingClockSource: 'bybit',
    };
    const hedge = {
      id: 'test', symbol: varPair.symbol, trackedVenue: varPair.venueA || 'hyperliquid',
      trackedSize: 1000, variationalSize: -1000, variationalEntryPx: 1,
      openedAt: Date.now() - 3 * 86400000, status: 'open',
    };
    const varEvents = VH.buildVariationalFundingEventsScheduled(hedge, listing);
    const merged1 = mergeVariationalIntoSeries(pairedOnly, varEvents);
    const merged2 = mergeVariationalIntoSeries(pairedOnly, varEvents);
    assertRowEventConsistency(merged1, 'variational-merged');
    assert.ok(Math.abs(sumSeries(merged1).funding - sumSeries(merged2).funding) < 1e-6,
      'variational merge must be idempotent from same base');
    const varSum = varEvents
      .filter(e => e.time >= bucharestDayStartMs(pairedOnly[0].day)
        && e.time <= bucharestDayEndMs(pairedOnly.at(-1).day))
      .reduce((s, e) => s + e.usdc, 0);
    const mergedVar = merged1.reduce((s, r) => s + (r.byVenue?.variational || 0), 0);
    assert.ok(Math.abs(mergedVar - varSum) < 1e-4,
      `merged variational ${mergedVar} vs clipped events ${varSum}`);
  }
}

console.log('daily-funding-series.test.mjs: PASS');
