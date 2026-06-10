/**
 * Verify supply / borrow / total APY against live portfolio + production CG prices.
 * Run: node tests/verify-protocol-apy.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const portfolio = JSON.parse(JSON.parse(readFileSync('_live-portfolio.json', 'utf8')).result);
const snaps = portfolio._snapshots || {};
const w23 = snaps['2026-W23'];
const w24 = snaps['2026-W24'];
assert.ok(w23, 'W23 snapshot required');
const tsW23 = Date.parse(w23.date);
const tsLatest = Date.parse(w24?.date || w23.date);

const GECKO_IDS = { GHO: 'gho', USDT: 'tether', REUSD: 'reusd', USDC: 'usd-coin', USD: 'usd-coin' };
const symbols = new Set();
for (const p of portfolio.protocols || []) {
  for (const sec of p.sections || []) {
    for (const pos of sec.positions || []) {
      for (const t of pos.tokens || []) {
        const m = String(t).match(/\s+(\S+)$/);
        if (m) symbols.add(m[1].toUpperCase());
      }
    }
  }
}
const ids = [...symbols].map((s) => GECKO_IDS[s]).filter(Boolean).join(',');
const priceRes = await fetch(`https://testedefi.vercel.app/api/prices?ids=${ids}`);
const priceJson = await priceRes.json();
const livePrices = {};
for (const sym of symbols) {
  const id = GECKO_IDS[sym];
  const usd = priceJson[id]?.usd;
  if (Number.isFinite(usd) && usd > 0) livePrices[sym] = usd;
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8765/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof protocolAprBreakdown === 'function', null, { timeout: 30000 });

const result = await page.evaluate(({ protocols, tokens, w23Protocols, tsW23, tsLatest, injectedPrices }) => {
  data.protocols = w23Protocols;
  normalizePortfolioData();
  for (const [sym, usd] of Object.entries(injectedPrices)) livePrices[sym] = usd;
  const baselineEntry = {
    v: 3,
    ts: tsW23,
    snapshot: true,
    protocols: JSON.parse(JSON.stringify(w23Protocols)),
    positions: buildPositionMap(w23Protocols),
  };
  data.protocols = protocols;
  normalizePortfolioData();
  const regularEntry = {
    v: 3,
    ts: tsLatest,
    snapshot: false,
    positions: buildPositionMap(protocols),
  };
  localStorage.setItem('protocol-import-history', JSON.stringify([baselineEntry, regularEntry]));

  const protocolRows = [];
  for (const p of data.protocols) {
    const b = protocolAprBreakdown(p);
    const row = {
      name: p.name,
      net: protocolNetValue(p),
      suppliedApr: b?.suppliedApr ?? null,
      borrowedApr: b?.borrowedApr ?? null,
      totalApr: b?.totalApr ?? null,
      sections: [],
    };
    for (const sec of p.sections || []) {
      const lb = lendingSectionApyBreakdown(p, sec);
      const positions = (sec.positions || []).map((pos) => {
        const prefix = protocolSectionKeyPrefix(p, sec);
        const key = `${prefix}:${pos.sub ? `${pos.sub}:` : ''}${pos.pool}`;
        const { apr, daysDiff } = calcPositionAPR(key);
        return {
          sub: pos.sub,
          pool: pos.pool,
          val: protocolPositionValue(pos),
          importVal: Number(pos.value || 0),
          rawApr: apr,
          daysDiff,
        };
      });
      row.sections.push({ type: sec.type, breakdown: lb, positions });
    }
    protocolRows.push(row);
  }

  const sortedProtocols = [...data.protocols];
  const totalBreakdown = sortedProtocols.reduce((acc, p) => {
    const b = protocolAprBreakdown(p);
    const w = Math.abs(protocolNetValue(p)) || protocolDisplayValue(p) || 0;
    if (b?.suppliedApr != null && Number.isFinite(b.suppliedApr)) {
      acc.supply += b.suppliedApr * w;
      acc.supplyW += w;
    }
    if (b?.borrowedApr != null && Number.isFinite(b.borrowedApr)) {
      acc.borrow += b.borrowedApr * w;
      acc.borrowW += w;
    }
    if (b?.totalApr != null && Number.isFinite(b.totalApr)) {
      acc.total += b.totalApr * w;
      acc.totalW += w;
    }
    return acc;
  }, { supply: 0, supplyW: 0, borrow: 0, borrowW: 0, total: 0, totalW: 0 });

  const ghoPos = data.protocols
    .flatMap((p) => p.sections || [])
    .flatMap((s) => s.positions || [])
    .find((pos) => pos.pool === 'GHO');

  const baseline = getAprBaselineSnapshot();
  return {
    livePrices: { ...livePrices },
    protocolRows,
    footer: {
      supply: totalBreakdown.supplyW ? totalBreakdown.supply / totalBreakdown.supplyW : null,
      borrow: totalBreakdown.borrowW ? totalBreakdown.borrow / totalBreakdown.borrowW : null,
      total: totalBreakdown.totalW ? totalBreakdown.total / totalBreakdown.totalW : null,
    },
    gho: ghoPos
      ? {
          val: protocolPositionValue(ghoPos),
          importVal: ghoPos.value,
          manualValue: ghoPos.manualValue,
          manualUsd: ghoPos.manualUsd,
        }
      : null,
    baselineTs: baseline?.ts,
    baselineDate: baseline?.date,
    latestImportTs: getLatestProtocolImportTs(),
    daysDiff: baseline ? protocolAprDaysDiff(baseline.ts, getLatestProtocolImportTs()) : null,
  };
}, {
  protocols: portfolio.protocols,
  tokens: portfolio.tokens || [],
  w23Protocols: w23.protocols,
  tsW23,
  tsLatest,
  injectedPrices: livePrices,
});

await browser.close();

console.log('CoinGecko prices:', result.livePrices);
console.log('Baseline:', result.baselineDate, 'days used:', result.daysDiff?.toFixed(2));
console.log('GHO:', result.gho);
console.log('\nProtocol APY breakdown:');
for (const row of result.protocolRows) {
  const fmt = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
  console.log(
    `  ${row.name.padEnd(14)} net=${row.net.toFixed(0).padStart(8)}  supply=${fmt(row.suppliedApr)}  borrow=${fmt(row.borrowedApr)}  total=${fmt(row.totalApr)}`,
  );
}
const fmt = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
console.log('\nFooter totals:', `supply=${fmt(result.footer.supply)}`, `borrow=${fmt(result.footer.borrow)}`, `total=${fmt(result.footer.total)}`);

const fluid = result.protocolRows.find((r) => r.name === 'Fluid');
const ghoSection = fluid?.sections?.find((s) => s.positions?.some((p) => p.pool === 'GHO'));
const ghoPos = ghoSection?.positions?.find((p) => p.pool === 'GHO');

assert.ok(result.gho, 'GHO position must exist');
assert.ok(Math.abs(result.gho.val - 30104.6862) < 1, `GHO value should peg ~30104.69, got ${result.gho.val}`);
assert.equal(result.gho.manualValue, undefined, 'stale manualValue must be cleared');
assert.ok(ghoPos.rawApr != null, 'GHO must have calculable APR');
assert.ok(Math.abs(ghoPos.rawApr) < 40, `GHO raw APR must be sane, got ${ghoPos.rawApr}`);
assert.ok(Math.abs(ghoPos.rawApr) > 0.5, `GHO raw APR too small, got ${ghoPos.rawApr}`);

if (fluid) {
  assert.ok(fluid.borrowedApr != null, 'Fluid borrow APY must exist');
  assert.ok(fluid.borrowedApr < 0, 'Fluid borrow APY must be negative');
  assert.ok(Math.abs(fluid.borrowedApr) < 40, `Fluid borrow APY must be sane, got ${fluid.borrowedApr}`);
  assert.ok(fluid.suppliedApr != null, 'Fluid supply APY must exist');
  assert.ok(fluid.totalApr != null, 'Fluid total APY must exist');
}

for (const row of result.protocolRows) {
  for (const apr of [row.suppliedApr, row.borrowedApr, row.totalApr]) {
    if (apr != null) assert.ok(Math.abs(apr) <= 80, `${row.name} APY ${apr} exceeds PROTO_APR_MAX_ABS filter`);
  }
}

console.log('\nPASS: supply / borrow / total APY verification');
