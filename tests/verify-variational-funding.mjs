/**
 * Verify Variational funding schedule + enrichment semantics.
 * Run: node tests/verify-variational-funding.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VH = require('../lib/variational-hedge.js');

const {
  buildVariationalFundingEvents,
  buildVariationalFundingEventsScheduled,
  buildVariationalFundingEventsAligned,
  estimateVariationalFundingUsd,
  variationalFundingPaymentPerInterval,
  variationalNextFundingAtMs,
  variationalHedgeOpenedAtMs,
  parseVariationalListing,
} = VH;

const H8 = 8 * 3600000;
const H4 = 4 * 3600000;
const ANCHOR_8H = Date.parse('2026-06-25T00:00:00.000Z');

const listing = {
  symbol: 'ETH',
  markPx: 3200,
  fundingRateInterval: 0.08 / 1095,
  fundingIntervalS: 28800,
  fundingIntervalHours: 8,
  fundingRateAnnual: 0.08,
  fundingNextAtMs: ANCHOR_8H,
  fundingClockSource: 'bybit',
};

function hedgeAt(openedAtMs, overrides = {}) {
  return {
    id: 'verify-hedge',
    symbol: 'ETH',
    trackedVenue: 'hyperliquid',
    trackedSize: 2,
    variationalSize: -2,
    variationalEntryPx: 3180,
    openedAt: openedAtMs,
    status: 'open',
    ...overrides,
  };
}

function listing4h() {
  return {
    ...listing,
    fundingIntervalS: 14400,
    fundingIntervalHours: 4,
    fundingRateInterval: 0.08 / 2190,
    fundingNextAtMs: ANCHOR_8H,
  };
}

// --- Reference-exchange anchor grid (live Bybit nextFundingTime) ---
{
  const now = 1782331467000;
  const bybitNext = 1782345600000;
  const ours = variationalNextFundingAtMs(null, { fundingIntervalS: 28800, fundingNextAtMs: bybitNext }, now);
  assert.equal(ours, bybitNext);
}

// --- Settlements on anchor grid ---
{
  const openedAt = Date.parse('2026-06-24T09:00:00.000Z');
  const now = Date.parse('2026-06-24T17:00:00.000Z');
  const events = buildVariationalFundingEventsScheduled(hedgeAt(openedAt), listing, { now });
  assert.equal(events.length, 1);
  assert.equal(events[0].time, Date.parse('2026-06-24T16:00:00.000Z'));
}

{
  const openedAt = Date.parse('2026-06-24T09:00:00.000Z');
  const now = Date.parse('2026-06-25T01:00:00.000Z');
  const events = buildVariationalFundingEventsScheduled(hedgeAt(openedAt), listing, { now });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.time), [
    Date.parse('2026-06-24T16:00:00.000Z'),
    Date.parse('2026-06-25T00:00:00.000Z'),
  ]);
}

{
  const openedAt = Date.parse('2026-06-24T17:01:00.000Z');
  const now = Date.parse('2026-06-24T18:00:00.000Z');
  assert.equal(buildVariationalFundingEventsScheduled(hedgeAt(openedAt), listing, { now }).length, 0);
  assert.equal(
    variationalNextFundingAtMs(null, listing, now),
    Date.parse('2026-06-25T00:00:00.000Z'),
  );
}

// --- Without clock anchor: no scheduled settlements ---
{
  const noClock = { ...listing, fundingNextAtMs: null, fundingClockSource: null };
  const openedAt = Date.parse('2026-06-24T09:00:00.000Z');
  const now = Date.parse('2026-06-25T01:00:00.000Z');
  assert.equal(buildVariationalFundingEventsScheduled(hedgeAt(openedAt), noClock, { now }).length, 0);
  assert.equal(variationalNextFundingAtMs(null, noClock, now), null);
}

// --- 4h interval on same anchor ---
{
  const openedAt = Date.parse('2026-06-24T10:00:00.000Z');
  const now = Date.parse('2026-06-24T13:00:00.000Z');
  const events = buildVariationalFundingEventsScheduled(hedgeAt(openedAt), listing4h(), { now });
  assert.equal(events.length, 1);
  assert.equal(events[0].time, Date.parse('2026-06-24T12:00:00.000Z'));
}

// --- HL payments must not create Variational rows early ---
{
  const openedAt = Date.parse('2026-06-24T17:01:00.000Z');
  const now = Date.parse('2026-06-24T18:00:00.000Z');
  const early = buildVariationalFundingEventsAligned(
    hedgeAt(openedAt),
    listing,
    [{ time: Date.parse('2026-06-24T17:30:00.000Z'), usdc: 1.5, intervalHours: 1 }],
    { now },
  );
  assert.equal(early.length, 0);
}

// --- Amount signs ---
const shortPay = variationalFundingPaymentPerInterval(-2, 3190, listing.fundingRateInterval);
const longPay = variationalFundingPaymentPerInterval(2, 3190, listing.fundingRateInterval);
assert.ok(shortPay > 0);
assert.ok(longPay < 0);

// --- estimate equals event sum ---
{
  const openedAt = Date.parse('2026-06-24T09:00:00.000Z');
  const now = Date.parse('2026-06-25T01:00:00.000Z');
  const h = hedgeAt(openedAt);
  const events = buildVariationalFundingEventsScheduled(h, listing, { now });
  assert.ok(Math.abs(estimateVariationalFundingUsd(h, listing, now) - events.reduce((s, e) => s + e.usdc, 0)) < 1e-9);
}

// --- Live Variational + Bybit clock (optional network) ---
try {
  const [statsRes, bybitRes] = await Promise.all([
    fetch(VH.VARIATIONAL_STATS_API, { signal: AbortSignal.timeout(12000) }),
    fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=XLMUSDT', { signal: AbortSignal.timeout(12000) }),
  ]);
  if (statsRes.ok && bybitRes.ok) {
    const stats = await statsRes.json();
    const bybit = await bybitRes.json();
    const parsed = parseVariationalListing((stats?.listings || []).find((l) => l?.ticker === 'XLM'));
    const row = bybit?.result?.list?.[0];
    const attached = require('../lib/variational-funding-clock.js').attachVariationalFundingClock(parsed, {
      source: 'bybit',
      nextFundingMs: Number(row?.nextFundingTime),
      referenceSymbol: row?.symbol,
      referenceIntervalS: Number(row?.fundingIntervalHour) * 3600,
    });
    assert.equal(attached.fundingIntervalS, Number(row?.fundingIntervalHour) * 3600);
    assert.ok(attached.fundingNextAtMs > Date.now() - 60000);
    console.log(`Live XLM clock: ${attached.fundingClockSource} next=${new Date(attached.fundingNextAtMs).toISOString()} interval=${attached.fundingIntervalHours}h`);
  }
} catch (e) {
  console.warn('Skipping live clock check:', e.message);
}

console.log('verify-variational-funding.mjs: PASS');
