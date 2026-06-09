import assert from 'node:assert/strict';
import DefiPnl from '../lib/defi-pnl.js';

const {
  FifoQtyLedger,
  FifoUsdLedger,
  computeWalletPnlSeries,
  computeProtocolPnlSeries,
  processQtyTransition,
  processUsdTransition,
  aggregateProtocolImportPositionsToNet,
  dedupeProtocolPnlTimeline,
} = DefiPnl;

// Partial BTC sell: 0.5 -> 0.4, price rises 40k -> 50k
{
  const ledger = new FifoQtyLedger();
  ledger.addLot(0.5, 20000);
  processQtyTransition(ledger, 0.5, 20000, 0.4, 20000);
  const price = 50000;
  assert.ok(Math.abs(ledger.realized - 1000) < 0.01, 'realized on 0.1 BTC sold');
  assert.ok(Math.abs(ledger.unrealized(price) - 4000) < 0.01, 'unrealized on remaining 0.4');
  assert.ok(Math.abs(ledger.totalPnl(price) - 5000) < 0.01, 'total PNL preserved');
}

// BTC increase: 0.5 -> 0.7 with higher mark
{
  const ledger = new FifoQtyLedger();
  ledger.addLot(0.5, 20000);
  processQtyTransition(ledger, 0.5, 20000, 0.7, 35000);
  const price = 50000;
  assert.ok(Math.abs(ledger.qty() - 0.7) < 1e-9);
  assert.ok(Math.abs(ledger.totalPnl(price) - 5000) < 0.01);
}

// Realized persists after full sell
{
  const series = computeWalletPnlSeries([
    { ts: 1, tokens: [{ symbol: 'BTC', amount: 0.5, value: 20000 }] },
    { ts: 2, tokens: [{ symbol: 'BTC', amount: 0.4, value: 20000 }] },
    { ts: 3, tokens: [{ symbol: 'BTC', amount: 0, value: 0 }] },
  ]);
  assert.equal(series.points.length, 3);
  assert.ok(series.points[2].totalPnl > 0, 'realized kept after full sell');
}

// Token reappears as new lot; prior realized still in total
{
  const series = computeWalletPnlSeries([
    { ts: 1, tokens: [{ symbol: 'ETH', amount: 1, value: 3000 }] },
    { ts: 2, tokens: [] },
    { ts: 3, tokens: [{ symbol: 'ETH', amount: 0.5, value: 2000 }] },
  ]);
  const last = series.points[series.points.length - 1].totalPnl;
  assert.ok(Number.isFinite(last));
}

// Protocol partial close
{
  const key = 'Aave|||Lending:supplied:USDe';
  const series = computeProtocolPnlSeries([
    { ts: 1, positions: { [key]: { value: 1000, qty: null } } },
    { ts: 2, positions: { [key]: { value: 800, qty: null } } },
  ]);
  assert.equal(series.points.length, 2);
}

// Protocol full close keeps total PNL (does not reset)
{
  const key = 'Aave|||Lending:supplied:USDe';
  const series = computeProtocolPnlSeries([
    { ts: 1, positions: { [key]: { value: 1000, qty: null } } },
    { ts: 2, positions: { [key]: { value: 1018, qty: null } } },
    { ts: 3, positions: {} },
  ]);
  assert.ok(Number.isFinite(series.points[2].totalPnl));
  assert.equal(series.points[2].totalPnl, 18);
}

// Protocol increase adds new lot only when token qty grows (capital deposit)
{
  const ledger = new FifoUsdLedger();
  processUsdTransition(ledger, { value: 0, qty: null }, { value: 1000, qty: 100 });
  processUsdTransition(ledger, { value: 1000, qty: 100 }, { value: 1300, qty: 130 });
  assert.ok(Math.abs(ledger.totalPnl(1300) - 0) < 0.01);
}

// Yield between snapshots accrues as unrealized PNL (same token qty, higher value)
{
  const key = 'Yearn|||Yield::vbUSDC';
  const series = computeProtocolPnlSeries([
    { ts: 1, positions: { [key]: { value: 22000, qty: 22000 } } },
    { ts: 2, positions: { [key]: { value: 22312, qty: 22000 } } },
  ]);
  assert.ok(Math.abs(series.points[1].totalPnl - 312) < 0.01, 'APY yield in total PNL');
}

// Chart series is single total metric
{
  const wallet = computeWalletPnlSeries([
    { ts: 1000, tokens: [{ symbol: 'SOL', amount: 10, value: 1000 }] },
    { ts: 2000, tokens: [{ symbol: 'SOL', amount: 10, value: 1200 }] },
  ]);
  assert.ok(wallet.points.every(p => Number.isFinite(p.totalPnl)));
  assert.equal(Object.keys(wallet.points[0]).sort().join(','), 'label,totalPnl,ts');
}

// Leveraged loop: net-equity key tracks yield; gross supplied+borrowed legs over-count debt growth
{
  const netKey = 'Morpho|||__pnl__';
  const suppliedKey = 'Morpho|||Lending:supplied:USDe';
  const borrowedKey = 'Morpho|||Lending:borrowed:USDC';
  const days = 16;
  const perLeg = computeProtocolPnlSeries([
    { ts: 0, positions: {
      [suppliedKey]: { value: 106000, qty: null },
      [borrowedKey]: { value: 94000, qty: null },
    } },
    { ts: days * 86400000, positions: {
      [suppliedKey]: { value: 106000 + 106000 * 0.05 * days / 365, qty: null },
      [borrowedKey]: { value: 94000 + 94000 * 0.04 * days / 365, qty: null },
    } },
  ]);
  const netStart = 106000 - 94000;
  const netEnd = (106000 + 106000 * 0.05 * days / 365) - (94000 + 94000 * 0.04 * days / 365);
  const netSeries = computeProtocolPnlSeries([
    { ts: 0, positions: { [netKey]: { value: netStart, qty: null } } },
    { ts: days * 86400000, positions: { [netKey]: { value: netEnd, qty: null } } },
  ]);
  assert.ok(perLeg.total > netSeries.total * 2, 'gross legs must over-state leveraged loop PNL');
  assert.ok(Math.abs(netSeries.total - (netEnd - netStart)) < 1, 'net protocol key must match equity change');
}

{
  const legs = {
    'Morpho|||Lending:supplied:USDe': 106000,
    'Morpho|||Lending:Borrowed:USDC': 94000,
  };
  const net = aggregateProtocolImportPositionsToNet(legs);
  assert.ok(Math.abs(net['Morpho|||__pnl__'].value - 12000) < 0.01, 'Borrowed leg keys must subtract case-insensitively');
}

{
  const ts = Date.UTC(2026, 5, 21, 12);
  const bucket = dedupeProtocolPnlTimeline([
    { ts, positions: { 'A|||__pnl__': { value: 200000, qty: null } } },
    { ts: ts + 1000, positions: { 'A|||__pnl__': { value: 12000, qty: null } } },
    { ts: ts + 7 * 3600000, positions: { 'A|||__pnl__': { value: 12100, qty: null } } },
  ]);
  assert.equal(bucket.length, 2, 'protocol PNL timeline must collapse same-bucket duplicates');
  assert.equal(bucket[0].positions['A|||__pnl__'].value, 12000, 'later same-bucket snapshot must win');
}

console.log('PASS: defi-pnl cost-basis tests');
