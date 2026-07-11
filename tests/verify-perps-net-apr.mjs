/**
 * Verify Perps position Net APR: formula, range windows, latest-session scope.
 * Run: node tests/verify-perps-net-apr.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');

// --- Mirrors index.html helpers (keep in sync with perps position APR path) ---
function perpsStatRangeMs(range) {
  if (range === '1d') return 86400000;
  if (range === '7d') return 7 * 86400000;
  if (range === '30d') return 30 * 86400000;
  return null;
}

function perpsStatRangeWindowDays(range) {
  if (range === '1d') return 1;
  if (range === '7d') return 7;
  if (range === '30d') return 30;
  return null;
}

function perpsAnnualizeReturnPct(netUsd, margin, days) {
  if (!margin || !days || days <= 0 || !Number.isFinite(netUsd)) return null;
  return (netUsd / margin) * (365 / days) * 100;
}

function perpsSumDailyFundingSeries(series) {
  let funding = 0;
  let fees = 0;
  let net = 0;
  for (const row of series || []) {
    const dailyFunding = row.dailyFunding || 0;
    const dailyFees = row.dailyFees || 0;
    funding += dailyFunding;
    fees += dailyFees;
    net += row.dailyNet != null ? row.dailyNet : dailyFunding - dailyFees;
  }
  return { funding, fees, net };
}

function perpsDailyRowHasPerformanceActivity(row) {
  const eps = 0.0000001;
  return Math.abs(row?.dailyFunding || 0) > eps
    || Math.abs(row?.dailyFees || 0) > eps
    || Math.abs(row?.dailyNet || 0) > eps
    || (Array.isArray(row?.fundingEvents) && row.fundingEvents.length > 0)
    || (Array.isArray(row?.feeEvents) && row.feeEvents.length > 0);
}

function perpsSplitDailySeriesIntoSessions(rows) {
  const sessions = [];
  let current = [];
  for (const row of rows || []) {
    if (perpsDailyRowHasPerformanceActivity(row)) current.push(row);
    else if (current.length) {
      sessions.push(current);
      current = [];
    }
  }
  if (current.length) sessions.push(current);
  return sessions;
}

function perpsTrimPairDailySeriesToLatestSession(rows) {
  const sessions = perpsSplitDailySeriesIntoSessions(rows);
  return sessions.length ? sessions[sessions.length - 1] : [];
}

function perpsTrimDailyRowToCutoff(row, cutoff) {
  const hasFundingEvents = Array.isArray(row.fundingEvents);
  const hasFeeEvents = Array.isArray(row.feeEvents);
  const dayStart = Date.parse(`${row.day || ''}T00:00:00.000Z`);
  if (!hasFundingEvents && !hasFeeEvents) {
    if (Number.isFinite(dayStart) && dayStart < cutoff) return null;
    return row;
  }
  const fundingEvents = hasFundingEvents ? row.fundingEvents.filter((e) => (e.time || 0) >= cutoff) : [];
  const feeEvents = hasFeeEvents ? row.feeEvents.filter((e) => (e.time || 0) >= cutoff) : [];
  if (!fundingEvents.length && !feeEvents.length && Number.isFinite(dayStart) && dayStart < cutoff) return null;
  const dailyFunding = fundingEvents.reduce((s, e) => s + (e.usdc || 0), 0);
  const dailyFees = feeEvents.reduce((s, e) => s + (e.fee || 0), 0);
  return { ...row, dailyFunding, dailyFees, dailyNet: dailyFunding - dailyFees, fundingEvents, feeEvents };
}

function perpsRecomputeDailySeriesCumulative(rows) {
  let cumFunding = 0;
  let cumFees = 0;
  let cumNet = 0;
  return (rows || []).map((row) => {
    const dailyFunding = row.dailyFunding || 0;
    const dailyFees = row.dailyFees || 0;
    const dailyNet = row.dailyNet != null ? row.dailyNet : dailyFunding - dailyFees;
    cumFunding += dailyFunding;
    cumFees += dailyFees;
    cumNet += dailyNet;
    return { ...row, dailyFunding, dailyFees, dailyNet, cumFunding, cumFees, cumNet };
  });
}

function perpsFilterPairLatestSessionForRange(series, range, now = Date.now()) {
  let rows = perpsTrimPairDailySeriesToLatestSession(series);
  const ms = perpsStatRangeMs(range);
  if (ms) {
    const cutoff = now - ms;
    rows = rows
      .filter((r) => new Date(`${r.day}T23:59:59.999Z`).getTime() >= cutoff)
      .map((r) => perpsTrimDailyRowToCutoff(r, cutoff))
      .filter(Boolean);
  }
  return perpsRecomputeDailySeriesCumulative(rows);
}

function perpsDailySeriesSpanDays(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const first = Date.parse(`${list[0]?.day || ''}T12:00:00Z`);
  const last = Date.parse(`${list.at(-1)?.day || ''}T12:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return Math.max(list.length, 1);
  return Math.max(1, Math.round((last - first) / 86400000) + 1);
}

function perpsPairUsesSinceOpen(p, range) {
  const daysOpen = p.daysOpen;
  if (daysOpen == null || daysOpen <= 0) return false;
  if (!perpsStatRangeMs(range)) return true;
  const windowDays = perpsStatRangeWindowDays(range);
  return windowDays != null && daysOpen <= windowDays;
}

function perpsPairEffectiveDays(p, range) {
  const daysOpen = p.daysOpen;
  if (daysOpen != null && daysOpen > 0 && perpsPairUsesSinceOpen(p, range)) return daysOpen;
  if (!perpsStatRangeMs(range)) return daysOpen != null && daysOpen > 0 ? daysOpen : null;
  return perpsStatRangeWindowDays(range) ?? 30;
}

function perpsPairAprDaysForRows(p, range, rows) {
  const span = perpsDailySeriesSpanDays(rows);
  if (span != null && rows?.length) return span;
  return perpsPairEffectiveDays(p, range);
}

function perpsPairPeriodApr(p, range, now = Date.now()) {
  const margin = p.avgNotional ?? 0;
  if (!margin) return null;
  const rawRows = Array.isArray(p.dailyPerformanceSeries) ? p.dailyPerformanceSeries : [];
  const rows = perpsFilterPairLatestSessionForRange(rawRows, range, now);
  if (rows.length) {
    const totals = perpsSumDailyFundingSeries(rows);
    const days = perpsPairAprDaysForRows(p, range, rows);
    return perpsAnnualizeReturnPct(totals.funding, margin, days);
  }
  if (rawRows.length && perpsStatRangeMs(range)) return null;
  const days = perpsPairEffectiveDays(p, range);
  return perpsAnnualizeReturnPct(p.fundingSinceOpen ?? 0, margin, days);
}

function expectedApr(net, margin, days) {
  return (net / margin) * (365 / days) * 100;
}

function dayStr(now, offsetDays) {
  return new Date(now - offsetDays * 86400000).toISOString().slice(0, 10);
}

function dailyRows(now, count, netPerDay = 9, feePerDay = 1) {
  return Array.from({ length: count }, (_, i) => ({
    day: dayStr(now, count - 1 - i),
    dailyFunding: netPerDay + feePerDay,
    dailyFees: feePerDay,
    dailyNet: netPerDay,
  }));
}

const NOW = Date.parse('2026-06-24T18:00:00.000Z');
const MARGIN = 100_000;

// --- Formula: APR = (funding / margin) * (365 / days) * 100 ---
{
  const apr = perpsAnnualizeReturnPct(100, MARGIN, 10);
  assert.ok(Math.abs(apr - expectedApr(100, MARGIN, 10)) < 1e-9);
  assert.ok(Math.abs(apr - 3.65) < 0.001, `10d $100 funding → ~3.65% APR, got ${apr}`);
}

// --- All: full latest session ---
{
  const p = { avgNotional: MARGIN, daysOpen: 10, dailyPerformanceSeries: dailyRows(NOW, 10) };
  const apr = perpsPairPeriodApr(p, null, NOW);
  assert.ok(Math.abs(apr - expectedApr(100, MARGIN, 10)) < 0.01);
}

// --- 30D: min(session, 30d) — 20d session uses all 20d ---
{
  const p = { avgNotional: MARGIN, daysOpen: 20, dailyPerformanceSeries: dailyRows(NOW, 20) };
  const all = perpsPairPeriodApr(p, null, NOW);
  const d30 = perpsPairPeriodApr(p, '30d', NOW);
  assert.ok(Math.abs(all - d30) < 0.01, '20d session: All and 30D must match');
  assert.ok(Math.abs(d30 - expectedApr(200, MARGIN, 20)) < 0.01);
}

// --- 30D: 45d session → only last 30 calendar days ---
{
  const p = { avgNotional: MARGIN, daysOpen: 45, dailyPerformanceSeries: dailyRows(NOW, 45) };
  const d30 = perpsPairPeriodApr(p, '30d', NOW);
  const rows30 = perpsFilterPairLatestSessionForRange(p.dailyPerformanceSeries, '30d', NOW);
  assert.equal(rows30.length, 30, '30D must keep 30 daily rows');
  assert.ok(Math.abs(d30 - expectedApr(300, MARGIN, 30)) < 0.01);
  const all = perpsPairPeriodApr(p, null, NOW);
  assert.ok(Math.abs(all - expectedApr(450, MARGIN, 45)) < 0.01);
  assert.ok(Math.abs(all - d30) < 0.01, 'constant daily rate: All and 30D APR should match');
}

// --- 7D on 20d session ---
{
  const p = { avgNotional: MARGIN, daysOpen: 20, dailyPerformanceSeries: dailyRows(NOW, 20) };
  const d7 = perpsPairPeriodApr(p, '7d', NOW);
  assert.ok(Math.abs(d7 - expectedApr(70, MARGIN, 7)) < 0.01);
}

// --- 1D on multi-day session ---
{
  const p = { avgNotional: MARGIN, daysOpen: 20, dailyPerformanceSeries: dailyRows(NOW, 20) };
  const d1 = perpsPairPeriodApr(p, '1d', NOW);
  const rows1 = perpsFilterPairLatestSessionForRange(p.dailyPerformanceSeries, '1d', NOW);
  assert.equal(rows1.length, 1, '1D must keep only the latest day row');
  assert.ok(Math.abs(d1 - expectedApr(10, MARGIN, 1)) < 0.01);
  const d7 = perpsPairPeriodApr(p, '7d', NOW);
  assert.ok(Math.abs(d1 - d7) < 0.01, 'constant daily rate: 1D and 7D APR should match');
}

// --- Varying daily rate: shorter windows can diverge from longer ones ---
{
  const rows = dailyRows(NOW, 20).map((r, i) => ({
    ...r,
    dailyFunding: (i < 19 ? 1 : 100) + 1,
    dailyFees: 1,
    dailyNet: i < 19 ? 1 : 100,
  }));
  const p = { avgNotional: MARGIN, daysOpen: 20, dailyPerformanceSeries: rows };
  const d1 = perpsPairPeriodApr(p, '1d', NOW);
  const d7 = perpsPairPeriodApr(p, '7d', NOW);
  assert.ok(d1 > d7, 'spike on last day: 1D APR must exceed 7D APR');
}

// --- Short session: 3d position, 30D selector uses full session ---
{
  const p = { avgNotional: MARGIN, daysOpen: 3, dailyPerformanceSeries: dailyRows(NOW, 3, 30, 0) };
  const all = perpsPairPeriodApr(p, null, NOW);
  const d30 = perpsPairPeriodApr(p, '30d', NOW);
  assert.ok(Math.abs(all - d30) < 0.01);
  assert.ok(Math.abs(all - expectedApr(90, MARGIN, 3)) < 0.05);
}

// --- Latest session only: ignore prior closed session ---
{
  const old = dailyRows(NOW - 60 * 86400000, 5, 100, 0);
  const gap = [{ day: dayStr(NOW, 10), dailyFunding: 0, dailyFees: 0, dailyNet: 0 }];
  const current = dailyRows(NOW, 5, 9, 1);
  const p = {
    avgNotional: MARGIN,
    daysOpen: 5,
    dailyPerformanceSeries: [...old, ...gap, ...current],
  };
  const apr = perpsPairPeriodApr(p, null, NOW);
  assert.ok(Math.abs(apr - expectedApr(50, MARGIN, 5)) < 0.01, 'must ignore old session before gap');
}

// --- UI wiring in index.html ---
assert.match(indexHtml, /const periodApr = perpsPairPeriodApr\(p, _perpsStatRange\)/);
assert.match(indexHtml, /perpsSetStatRange[\s\S]*?perpsRenderPositionsPanel/);
assert.match(indexHtml, /perpsAnnualizeReturnPct\(totals\.funding, margin, days\)/, 'Net APR must annualize funding only');
assert.match(indexHtml, /Annualized funding ÷ margin · excludes trading fees/, 'Net APR tooltip must describe funding-only basis');

console.log('verify-perps-net-apr.mjs: PASS');
console.log('  formula, 1D/7D/30D/All windows, session scope, and UI wiring verified');
