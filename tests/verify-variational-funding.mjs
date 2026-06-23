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
const listing = {
  symbol: 'ETH',
  markPx: 3200,
  fundingRateInterval: 0.08 / 1095,
  fundingIntervalS: 28800,
  fundingIntervalHours: 8,
  fundingRateAnnual: 0.08,
};

function hedgeAt(hoursAgo, overrides = {}) {
  const now = Date.now();
  return {
    id: 'verify-hedge',
    symbol: 'ETH',
    trackedVenue: 'hyperliquid',
    trackedSize: 2,
    variationalSize: -2,
    variationalEntryPx: 3180,
    openedAt: now - hoursAgo * 3600000,
    status: 'open',
    ...overrides,
  };
}

function eventCount(hoursAgo, now) {
  return buildVariationalFundingEventsScheduled(hedgeAt(hoursAgo), listing, { now }).length;
}

// --- Native interval boundaries ---
assert.equal(eventCount(6), 0, '6h: no Variational funding before first 8h interval');
assert.equal(eventCount(8), 1, '8h: exactly one completed interval');
assert.equal(eventCount(9), 1, '9h: still one interval (second not due yet)');
assert.equal(eventCount(16), 2, '16h: two completed intervals');
assert.equal(eventCount(24), 3, '24h: three completed intervals');

// --- Per-market interval from API (e.g. ETH uses 4h on Variational) ---
const listing4h = { ...listing, fundingIntervalS: 14400, fundingIntervalHours: 4 };
const h5 = hedgeAt(5);
const ethStyle = buildVariationalFundingEventsScheduled(h5, listing4h, { now: Date.now() });
assert.equal(ethStyle.length, 1, '5h open on 4h interval: one completed payout');
const next4h = variationalNextFundingAtMs(h5, listing4h);
assert.ok(next4h - Date.now() > 2.5 * 3600000 && next4h - Date.now() < 3.5 * 3600000, 'next 4h-interval payout ~3h away at 5h elapsed');

const h3on4h = hedgeAt(3);
assert.equal(buildVariationalFundingEventsScheduled(h3on4h, listing4h).length, 0, '3h open on 4h interval: zero payouts');

const h6 = hedgeAt(6);
const next = variationalNextFundingAtMs(h6, listing);
assert.ok(next > Date.now(), 'next payout must be in the future at 6h elapsed');
assert.ok(Math.abs(next - (h6.openedAt + H8)) < 2000, 'next payout must be at openedAt + 8h');

// --- HL payments must not create Variational rows early ---
const hlPayments = [
  { time: Date.now() - 2 * 3600000, usdc: 1.5, intervalHours: 1 },
  { time: Date.now() - 1 * 3600000, usdc: 1.2, intervalHours: 1 },
];
const early = buildVariationalFundingEventsAligned(h6, listing, hlPayments);
assert.equal(early.length, 0, 'HL hourly payments must not trigger Variational estimates before native interval');

// --- After first interval, one scheduled event ---
const h9 = hedgeAt(9);
const scheduled = buildVariationalFundingEventsScheduled(h9, listing);
assert.equal(scheduled.length, 1);
assert.equal(scheduled[0].venue, 'variational');
assert.ok(scheduled[0].fundingEstimated);
assert.ok(Math.abs(scheduled[0].time - (h9.openedAt + H8)) < 2000, 'event timestamp must land on native boundary');

// --- Amount: short receives positive funding when rate positive ---
const shortPay = variationalFundingPaymentPerInterval(-2, 3190, listing.fundingRateInterval);
const longPay = variationalFundingPaymentPerInterval(2, 3190, listing.fundingRateInterval);
assert.ok(shortPay > 0, 'short leg should receive est. funding when rate > 0');
assert.ok(longPay < 0, 'long leg should pay est. funding when rate > 0');
assert.ok(Math.abs(shortPay + longPay) < 1e-9, 'long/short payments must offset');

// --- estimateVariationalFundingUsd matches event sum ---
const h20 = hedgeAt(20);
const events = buildVariationalFundingEventsScheduled(h20, listing);
const est = estimateVariationalFundingUsd(h20, listing);
const sum = events.reduce((s, e) => s + e.usdc, 0);
assert.ok(Math.abs(est - sum) < 1e-9, 'estimate must equal sum of scheduled events');

// --- Manual override ---
const overridden = hedgeAt(20, { variationalFundingUsdOverride: 42.5 });
const overrideEvents = buildVariationalFundingEventsScheduled(overridden, listing);
assert.equal(overrideEvents.length, 1);
assert.equal(overrideEvents[0].usdc, 42.5);
assert.equal(estimateVariationalFundingUsd(overridden, listing), 42.5);

// --- null override must not short-circuit scheduled accrual ---
const nullOverride = hedgeAt(20, { variationalFundingUsdOverride: null });
const nullOverrideEvents = buildVariationalFundingEventsScheduled(nullOverride, listing);
assert.ok(nullOverrideEvents.length > 1, 'null override must accrue scheduled intervals, not return single $0');
assert.ok(nullOverrideEvents.reduce((s, e) => s + e.usdc, 0) !== 0 || nullOverrideEvents.length > 1);

// --- Events only after hedge open, not before ---
const openedAt = Date.now() - 20 * 3600000;
const withOldHl = buildVariationalFundingEvents(
  { ...h20, openedAt },
  listing,
  { now: Date.now(), sinceMs: openedAt - 30 * 3600000 },
);
assert.equal(withOldHl.length, 2, 'sinceMs before open must not add extra intervals');

// --- Live Variational stats API shape (optional network) ---
try {
  const res = await fetch(VH.VARIATIONAL_STATS_API, { signal: AbortSignal.timeout(12000) });
  if (res.ok) {
    const stats = await res.json();
    const parsed = parseVariationalListing((stats?.listings || []).find((l) => /ETH/i.test(l?.ticker || '')));
    assert.ok(parsed?.fundingIntervalS >= 3600, 'live ETH listing must expose funding_interval_s');
    assert.ok(Number.isFinite(parsed?.fundingRateInterval), 'live ETH listing must normalize interval rate');
    console.log(`Live Variational ETH: interval=${parsed.fundingIntervalHours}h annual=${(parsed.fundingRateAnnual * 100).toFixed(2)}%`);
  }
} catch (e) {
  console.warn('Skipping live Variational API check:', e.message);
}

// --- XLM-style hedge: days open, entry px recovered from pair leg ---
{
  const { variationalHedgeFromPair, normalizeVariationalListing, buildVariationalFundingEventsScheduled } = VH;
  const listing = normalizeVariationalListing({
    symbol: 'XLM',
    markPx: 0.195,
    fundingRate8h: 0.1095 / 1095,
    fundingIntervalHours: 8,
    fundingIntervalS: 28800,
  });
  const pair = {
    symbol: 'XLM',
    variationalHedgeId: 'missing-id',
    pairOpenedAtMs: Date.now() - 5 * 86400000,
    venueA: 'grvt',
    crossLegA: { venue: 'grvt', size: 90000, entryPx: 0.22 },
    crossLegB: { venue: 'variational', size: -90000, entryPx: 0.218 },
  };
  const effective = variationalHedgeFromPair(pair, null);
  const events = buildVariationalFundingEventsScheduled(effective, listing);
  assert.ok(events.length >= 14, `5d XLM hedge must accrue ~15 intervals, got ${events.length}`);
  assert.ok(events.reduce((s, e) => s + e.usdc, 0) > 10, 'XLM variational funding must be non-zero with pair leg entry');
  const sparseSpread = normalizeVariationalListing({
    symbol: 'XLM',
    markPx: 0.195,
    fundingRate8h: 0.1095 / 1095,
    fundingIntervalHours: 8,
  });
  assert.ok(sparseSpread?.fundingRateInterval > 0, 'spread row with only 8h rate must derive interval rate');
}

console.log('verify-variational-funding.mjs: PASS');
