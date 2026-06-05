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
const {
  appendEquitySnapshotStore,
  buildEquitySnapshotFromDashboard,
  buildClosedPairs,
  buildDailyFundingSeries,
  computeCombinedNetDeposits,
  pairOpenedAtMs,
} = require('../lib/perps.js');
const aaveProxyHandler = require('../api/aave-proxy.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const perpsJs = readFileSync(join(ROOT, 'lib', 'perps.js'), 'utf8');
const aaveProxyJs = readFileSync(join(ROOT, 'api', 'aave-proxy.js'), 'utf8');
const syncJs = readFileSync(join(ROOT, 'api', 'sync.js'), 'utf8');
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
  const monthAgo = now - 35 * 86400000;
  const oneDayAgo = now - 86400000;
  const openMs = pairOpenedAtMs('ONDO', 'hyperliquid', 'nado', {
    hyperliquid: [{ symbol: 'ONDO', time: oneDayAgo, fee: 1 }],
    nado: [{ symbol: 'ONDO', time: monthAgo, fee: 1 }],
  }, {
    hyperliquid: [],
    nado: [{ symbol: 'ONDO', time: monthAgo, usdc: 0.5 }],
  });
  assert.equal(openMs, monthAgo, 'position performance must start when the first leg opened, not when the hedge completed');
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

{
  const open = now - 6 * 3600000;
  const close = now - 1 * 3600000;
  const closed = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'ENA', time: open, side: 'B', px: 0.1, sz: 50000, fee: 1, closedPnl: 0 },
      { venue: 'hyperliquid', symbol: 'ENA', time: close, side: 'A', px: 0.119, sz: 50000, fee: 1, closedPnl: 950 },
    ],
    extended: [
      { venue: 'extended', symbol: 'ENA', time: open + 1000, side: 'sell', px: 0.1, sz: 50000, fee: 1.5 },
      { venue: 'extended', symbol: 'ENA', time: close + 1000, side: 'buy', px: 0.1192, sz: 50000, fee: 1.5 },
    ],
  }, {
    hyperliquid: [{ venue: 'hyperliquid', symbol: 'ENA', time: open + 3600000, usdc: 12 }],
    extended: [{ venue: 'extended', symbol: 'ENA', time: open + 3600000, usdc: 8 }],
  });
  assert.equal(closed.length, 1, 'closed round-trip legs must be paired');
  assert.equal(Math.round(closed[0].closeSlippage), -10, 'closed slippage must be the net realized PnL of both legs');
  assert.equal(closed[0].funding, 20, 'closed PnL must include funding payments inside the round');
  assert.equal(closed[0].fees, 5, 'closed PnL must include trading fees from both legs');
  assert.equal(Math.round(closed[0].netPnl), 5, 'closed net PnL must equal slippage plus funding minus fees');
}

{
  const close = now - 2 * 3600000;
  const closed = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'ONDO', time: close, side: 'A', px: 0.92, sz: 10000, fee: 1.2, closedPnl: 150 },
    ],
    nado: [
      { venue: 'nado', symbol: 'ONDO', time: close + 60000, size: 10000, px: 0.921, fee: 1.1, realizedPnl: -155 },
    ],
  }, { hyperliquid: [], nado: [] });
  assert.equal(closed.length, 1, 'closing fills with realized PnL must recover rounds opened before the fill window');
  assert.equal(Math.round(closed[0].closeSlippage), -5, 'recovered closing-fill rounds must keep realized close slippage');
  assert.equal(closed[0].longLeg.reconstructedFromClosingFills, true, 'recovered long leg must be marked as reconstructed');
}

assert.match(indexHtml, /perpsTrimDailyRowToCutoff\(r, cutoff\)/, 'daily rows must be trimmed to the exact cutoff');
assert.match(indexHtml, /dayStart < cutoff\) return null;/, 'summary-only boundary rows must not count as full last-24h PnL');
assert.match(indexHtml, /return perpsRecomputeDailySeriesCumulative\(trimmed\);/, 'trimmed daily rows must rebuild cumulative totals from the selected window');
assert.match(indexHtml, /return t >= cutoff;/, 'equity points must use the exact rolling cutoff');
assert.match(indexHtml, /perpsRenderAlerts\(data\.paired \|\| \[\], data\.unhedged \|\| \[\], data\.summary \|\| \{\}\);/, 'alerts must refresh with the dashboard');
assert.doesNotMatch(perpsJs, /positions\.reduce\(\(s, p\) => s \+ \(p\.notional \|\| 0\), 0\)/, 'Extended notional must not be used as equity');
assert.match(perpsJs, /funding: extendedFundingWindow,/, 'Extended response must expose selected-window funding');
assert.match(perpsJs, /fundingSinceOpen: extendedFundingSinceOpen,/, 'Extended response must preserve since-open funding separately');
assert.match(perpsJs, /stats\.funding_rate/, 'Extended rates must tolerate snake_case funding-rate fields');

{
  const dashboard = (fetchedAt, total, overrides = {}) => ({
    fetchedAt,
    equityNow: { hl: total - 100, nado: 100, grvt: 0, extended: 0 },
    summary: {
      hlAccountValue: total - 100,
      nadoAccountValue: 100,
      grvtConfigured: false,
      extendedConfigured: false,
      combinedNetDeposits: 0,
      adjustedEquity: total,
      equitySnapshotEligible: true,
      ...overrides,
    },
  });
  const first = appendEquitySnapshotStore({}, dashboard(Date.UTC(2026, 5, 2, 8, 5), 1000));
  const second = appendEquitySnapshotStore(first, dashboard(Date.UTC(2026, 5, 2, 11, 55), 1200));
  assert.equal(Object.keys(second).length, 1, 'same 4h bucket must contain only one snapshot');
  assert.equal(second['2026-06-02T08'].totalEquity, 1000, 'minute refreshes must not rewrite a 4h snapshot');

  const incomplete = appendEquitySnapshotStore(second, dashboard(Date.UTC(2026, 5, 2, 12, 5), 200, {
    equitySnapshotEligible: false,
    equitySnapshotIssue: 'GRVT equity unavailable',
  }));
  assert.equal(Object.keys(incomplete).length, 1, 'incomplete venue reads must not create equity snapshots');

  const sampled = buildEquitySnapshotFromDashboard(dashboard(Date.UTC(2026, 5, 2, 12, 5), 1200, {
    equityCollectionSpanMs: 42,
    equityFetchedAts: { hyperliquid: 1, nado: 43 },
    equitySampleMode: 'concurrent_balance_only',
  }));
  assert.equal(sampled.record.equityCollectionSpanMs, 42, 'snapshot must preserve measured venue collection span');
  assert.equal(sampled.record.equitySampleMode, 'concurrent_balance_only', 'snapshot must identify balance-only sampling');
}

assert.match(indexHtml, /if \(store\[bucket\]\) return;/, 'browser snapshots must be append-only within each 4h bucket');
assert.match(indexHtml, /if \(!perpsIsEquitySnapshotEligible\(data\)\) return;/, 'browser snapshots must reject incomplete reads');
assert.match(aaveProxyJs, /portfolio\?\.perpsArb/, 'cron snapshots must recover wallet config from the saved portfolio');
assert.match(aaveProxyJs, /kvSet\('vault:perps_config'/, 'cron snapshots must persist recovered wallet config');
assert.match(aaveProxyJs, /fetchPerpsEquitySnapshot\(\{/, 'cron snapshots must use the lightweight concurrent balance sampler');
assert.doesNotMatch(aaveProxyJs.slice(aaveProxyJs.indexOf('async function handlePerpsCronSnapshot'), aaveProxyJs.indexOf('async function handlePerps(req')), /fetchPerpsDashboard\(\{/, 'cron snapshots must not run the heavy dashboard pipeline');
assert.match(perpsJs, /equitySampleMode: 'concurrent_balance_only'/, 'balance-only snapshots must identify their sampling mode');
assert.match(perpsJs, /await Promise\.all\(\[\s*fetchHyperliquidEquity/, 'venue equity endpoints must be sampled concurrently');
assert.match(syncJs, /const savedConfig = parseJson\(await kvGet\('vault:perps_config'\), \{\}\);/, 'fast config endpoint must use the initialized parser');
assert.doesNotMatch(syncJs, /const perpsConfig = parse\(await kvGet\('vault:perps_config'\), \{\}\);/, 'fast config endpoint must not call a parser before initialization');
assert.match(syncJs, /req\.query\?\.perpsSnapshots === '1'/, 'sync endpoint must expose lightweight Perps snapshot hydration');
assert.match(indexHtml, /await perpsHydrateSnapshotsFromCloud\(\);/, 'Perps refresh must hydrate cron snapshots before rendering the chart');
assert.match(indexHtml, /const merged = \{ \.\.\.local, \.\.\.\(serverSnaps \|\| \{\}\) \};/, 'scheduled server snapshots must replace same-bucket browser snapshots');
assert.match(indexHtml, /<g id="perpsEquityPoints"><\/g>/, 'equity chart must render visible sampled-point markers');
assert.match(indexHtml, /latest \$\{perpsFmtUsd\(chart\.plot\.at\(-1\)\?\.val\)\}/, 'equity chart badge must expose the latest plotted snapshot amount');
assert.match(indexHtml, /perpsPairDisplayLegEntries\(p\)/, 'position cards must order exchange labels with the long leg first');
assert.match(indexHtml, /perpsVenueWithSideHtml\(entry\.venue, entry\.leg\.size\)/, 'exchange labels must show long/short badges in position cards');
assert.match(indexHtml, /perpsSetPositionsTab\('closed'/, 'Positions panel must expose a Closed tab');
assert.match(indexHtml, /function perpsRenderClosedPositions\(closedPairs\)/, 'Closed tab must render fully closed position rounds');
assert.match(indexHtml, /p\.closeSlippage/, 'Closed tab must show closing slippage separately');
assert.match(perpsJs, /closedPairs: arb\.closedPairs/, 'Perps dashboard response must include closed pairs');
assert.match(perpsJs, /const PERPS_MAX_FILL_HISTORY_DAYS = 365;/, 'Closed tab must fetch a long enough fill history to show older closed rounds');
assert.match(perpsJs, /reconstructedFromClosingFills: true/, 'Closed tab must recover rounds whose opening fill is outside the fetched history');
assert.match(indexHtml, /perpsPositionFundingRecent/, 'position performance modal must include recent funding payments');
assert.match(indexHtml, /function perpsRecentFundingGroups\(p\)/, 'recent funding payments must support hourly net grouping');
assert.match(indexHtml, /perps-pos-funding-strip/, 'recent funding payments must render as a horizontal card strip');
assert.match(indexHtml, /Perps DEXs/, 'sidebar and search must use the Perps DEXs label');
assert.doesNotMatch(indexHtml, /Perps Arb/, 'old Perps Arb label must not remain in the UI');
assert.match(indexHtml, /function perpsFilterPairDailySeriesForPosition\(series, p\)/, 'position performance must use a dedicated position series filter');
assert.match(indexHtml, /function perpsTrimPairDailySeriesToLatestSession\(rows\)/, 'position performance must keep only the latest open session');
assert.match(indexHtml, /perpsTrimPairDailySeriesToLatestSession\(series\)/, 'position performance must drop closed gaps before charting');
assert.match(perpsJs, /Math\.min\(\.\.\.candidates\)/, 'position open time must use earliest fill or funding on either leg');
assert.match(perpsJs, /const perfDays = Math\.min\(PERPS_MAX_FILL_HISTORY_DAYS, Math\.max\(fillHistoryDays, openDays\)\)/, 'per-pair performance series must span from pair open through fill history');
assert.match(perpsJs, /days: perfDays,\s*\n\s*pairedBases: \[p\.symbol\]/, 'per-pair performance series must use computed performance window');
assert.match(indexHtml, /function perpsSyncTotalPnlRolling24h\(data\)/, 'Total PnL must use rolling 24h independent of stat window');
assert.match(indexHtml, /perpsSumDailyFundingSeries\(rows, true\)/, 'Net APR must use the same active-session rows as position performance');
assert.match(indexHtml, /perpsSideBadgeHtml\(legs\.a\.size\)/, 'paired table legs must include long/short badges');
assert.match(indexHtml, /perpsVenueWithSideHtml\(u\.venue, u\.size\)/, 'unhedged exchange rows must include long/short badges');
assert.match(indexHtml, /perpsRateSpreadRow\(p\.symbol\)/, 'Current APR must fall back to the latest rate-spread row');
assert.match(indexHtml, /rateA \?\? p\.fundingRate8hA/, 'live APR polling must preserve previous leg rates when a response is partial');
assert.match(indexHtml, /if \(native\.rateDecimal == null\)/, 'Current APR tooltip must fall back to pair-level leg rates');
assert.match(indexHtml, /perpsApplyLiveRates\(payload\.rateSpread, payload\.fetchedAt\)/, 'Current APR tooltip must retain the exact live-rate update time');
assert.match(perpsJs, /function grvtFundingSinceOpen\(pos\) \{[\s\S]*?return raw;/, 'GRVT cumulative funding must keep the same account-credit sign as funding history');
{
  const renderDashboard = indexHtml.slice(indexHtml.indexOf('function perpsRenderDashboard(data)'), indexHtml.indexOf('function perpsFormatConnectedStatus'));
  assert.ok(renderDashboard.indexOf('perpsSaveSnapshot(data);') < renderDashboard.indexOf('data._equitySeries = perpsBuildEquitySeries(data);'), 'dashboard must save the current 4h snapshot before building the plotted series');
}

{
  let statusCode = null;
  let responseBody = null;
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return body;
    },
  };
  await aaveProxyHandler({ method: 'GET', headers: {}, query: { cronSnapshot: '1' } }, res);
  assert.equal(statusCode, 401, 'cron snapshot GET must reach the protected Perps handler without a wallet query');
  assert.equal(responseBody?.error, 'Unauthorized');
}

console.log('PASS: perps accounting and dashboard regression checks');
