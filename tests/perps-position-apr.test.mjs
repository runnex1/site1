import assert from 'node:assert/strict';

/** Mirrors index.html perps position APR helpers for regression checks. */
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

function perpsStatRangeUsesFundingOnlyApr(range) {
  return range === '1d';
}

function perpsAnnualizeReturnPct(netUsd, margin, days) {
  if (!margin || !days || days <= 0 || !Number.isFinite(netUsd)) return null;
  return (netUsd / margin) * (365 / days) * 100;
}

function perpsSumDailyFundingSeries(series, useNet = true) {
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

function perpsFilterPairLatestSessionForRange(series, range) {
  let rows = [...(series || [])];
  const ms = perpsStatRangeMs(range);
  if (ms) {
    const cutoff = Date.now() - ms;
    rows = rows.filter((r) => new Date(`${r.day}T23:59:59.999Z`).getTime() >= cutoff);
  }
  return rows;
}

function perpsPairPeriodApr(p, range) {
  const margin = p.avgNotional ?? 0;
  if (!margin) return null;
  const fundingOnly = perpsStatRangeUsesFundingOnlyApr(range);
  const rawRows = Array.isArray(p.dailyPerformanceSeries) ? p.dailyPerformanceSeries : [];
  const rows = perpsFilterPairLatestSessionForRange(rawRows, range);
  if (rows.length) {
    const totals = perpsSumDailyFundingSeries(rows, !fundingOnly);
    const days = perpsPairAprDaysForRows(p, range, rows);
    const basisUsd = fundingOnly ? totals.funding : totals.net;
    return perpsAnnualizeReturnPct(basisUsd, margin, days);
  }
  const days = perpsPairEffectiveDays(p, range);
  const basisUsd = fundingOnly ? (p.fundingSinceOpen ?? 0) : (p.fundingSinceOpen ?? 0) - (p.feesSinceOpen ?? 0);
  return perpsAnnualizeReturnPct(basisUsd, margin, days);
}

const now = Date.now();
const day = (offset) => new Date(now - offset * 86400000).toISOString().slice(0, 10);

const pair = {
  symbol: 'BTC',
  avgNotional: 100000,
  daysOpen: 20,
  dailyPerformanceSeries: Array.from({ length: 20 }, (_, i) => ({
    day: day(19 - i),
    dailyFunding: 10,
    dailyFees: 1,
    dailyNet: 9,
  })),
};

const sessionApr = perpsPairPeriodApr(pair, null);
const window7d = perpsPairPeriodApr(pair, '7d');
const window30d = perpsPairPeriodApr(pair, '30d');
const window1d = perpsPairPeriodApr(pair, '1d');

assert.ok(sessionApr != null, 'session APR must be computable');
assert.ok(window7d != null, '7d APR must be computable');
assert.ok(window30d != null, '30d APR must be computable');
assert.ok(window1d != null, '1d APR must be computable');
assert.ok(Math.abs(sessionApr - window30d) < 0.01, '20d session inside 30d window should match full session APR');
assert.ok(window1d > window7d, '1D funding-only APR must exceed 7D net APR when fees are present');
assert.ok(Math.abs(window7d - window30d) > 0.01 || window7d !== sessionApr, '7d APR must differ from full session when session is longer');

const young = {
  ...pair,
  daysOpen: 3,
  dailyPerformanceSeries: [
    { day: day(2), dailyFunding: 30, dailyFees: 0, dailyNet: 30 },
    { day: day(1), dailyFunding: 30, dailyFees: 0, dailyNet: 30 },
    { day: day(0), dailyFunding: 30, dailyFees: 0, dailyNet: 30 },
  ],
};
const youngSession = perpsPairPeriodApr(young, null);
const young30d = perpsPairPeriodApr(young, '30d');
assert.ok(Math.abs(youngSession - young30d) < 0.01, '3d session should match 30d window when session is shorter');
assert.ok(Math.abs(youngSession - 10.95) < 0.2, `3d $90 net on 100k margin should annualize near 10.95%, got ${youngSession}`);

console.log('perps-position-apr.test.mjs: ok');
