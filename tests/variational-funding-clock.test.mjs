/**
 * Variational funding clock resolution tests.
 * Run: node tests/variational-funding-clock.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const clock = require('../lib/variational-funding-clock.js');

const {
  fundingSettlementsOnAnchorGrid,
  nextFundingOnAnchorGrid,
  pickFundingClockForBase,
  attachVariationalFundingClock,
} = clock;

const H8 = 8 * 3600000;
const ANCHOR_8H = Date.parse('2026-06-25T00:00:00.000Z');

assert.deepEqual(
  fundingSettlementsOnAnchorGrid(
    Date.parse('2026-06-24T09:00:00.000Z'),
    Date.parse('2026-06-25T01:00:00.000Z'),
    H8,
    ANCHOR_8H,
  ),
  [Date.parse('2026-06-24T16:00:00.000Z'), Date.parse('2026-06-25T00:00:00.000Z')],
);

assert.equal(
  nextFundingOnAnchorGrid(ANCHOR_8H, H8, Date.parse('2026-06-24T20:00:00.000Z')),
  ANCHOR_8H,
);

{
  const bybit = { XLM: { nextFundingMs: ANCHOR_8H, intervalS: 28800, symbol: 'XLMUSDT' } };
  const picked = pickFundingClockForBase('XLM', bybit, {});
  assert.equal(picked.source, 'bybit');
  assert.equal(picked.nextFundingMs, ANCHOR_8H);
}

{
  const listing = attachVariationalFundingClock(
    { symbol: 'XLM', fundingIntervalS: 28800 },
    { source: 'bybit', nextFundingMs: ANCHOR_8H, referenceSymbol: 'XLMUSDT' },
    Date.now(),
  );
  assert.equal(listing.fundingNextAtMs, ANCHOR_8H);
  assert.equal(listing.fundingClockSource, 'bybit');
}

console.log('variational-funding-clock.test.mjs: PASS');
