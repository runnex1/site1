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
  if (perpsStatRangeMs(range)) return perpsPairEffectiveDays(p, range);
  return perpsDailySeriesSpanDays(rows);
}

function perpsPairPeriodApr(p, range) {
  const margin = p.avgNotional ?? 0;
  if (!margin) return null;
  const rawRows = Array.isArray(p.dailyPerformanceSeries) ? p.dailyPerformanceSeries : [];
  const rows = rawRows;
  if (rows.length) {
    const totals = perpsSumDailyFundingSeries(rows);
    const days = perpsPairAprDaysForRows(p, range, rows);
    return perpsAnnualizeReturnPct(totals.net, margin, days);
  }
  return perpsAnnualizeReturnPct((p.fundingSinceOpen ?? 0) - (p.feesSinceOpen ?? 0), margin, perpsPairEffectiveDays(p, range));
}

const pair = {
  symbol: 'BTC',
  avgNotional: 100000,
  daysOpen: 20,
  dailyPerformanceSeries: [
    { day: '2026-06-01', dailyFunding: 10, dailyFees: 1, dailyNet: 9 },
    { day: '2026-06-02', dailyFunding: 10, dailyFees: 1, dailyNet: 9 },
    { day: '2026-06-03', dailyFunding: 10, dailyFees: 1, dailyNet: 9 },
  ],
};

const sessionApr = perpsPairPeriodApr(pair, null);
const windowApr = perpsPairPeriodApr(pair, '7d');

assert.ok(sessionApr != null, 'session APR must be computable');
assert.ok(windowApr != null, 'window APR must be computable');
assert.ok(Math.abs(sessionApr - windowApr) > 0.01, '20d session APR must differ from 7d-window APR when only 3 session days exist');

const young = {
  ...pair,
  daysOpen: 3,
  dailyPerformanceSeries: [
    { day: '2026-06-18', dailyFunding: 30, dailyFees: 0, dailyNet: 30 },
    { day: '2026-06-19', dailyFunding: 30, dailyFees: 0, dailyNet: 30 },
    { day: '2026-06-20', dailyFunding: 30, dailyFees: 0, dailyNet: 30 },
  ],
};
const youngSession = perpsPairPeriodApr(young, null);
assert.ok(Math.abs(youngSession - 10.95) < 0.2, `3d $90 net on 100k margin should annualize near 10.95%, got ${youngSession}`);

console.log('perps-position-apr.test.mjs: ok');
