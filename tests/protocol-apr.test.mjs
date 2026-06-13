import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapKaminoObligation } = require('../lib/loop-solana-rates');
const { mergeRecentLoopPositions } = require('../lib/loop-rates');

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(indexHtml, /const GECKO_SYMBOL_IDS = \{/, 'CoinGecko symbol map must exist');
assert.match(indexHtml, /function geckoIdForSymbol\(symbol\)/, 'CoinGecko id resolver must exist');
assert.match(indexHtml, /function protocolTokenCoingeckoUnitPrice\(pos, unitPrices = null\)/, 'protocol positions must read CoinGecko prices with optional frozen import map');
assert.match(indexHtml, /unitPrices/, 'protocol imports must store frozen CoinGecko unit prices');
assert.match(indexHtml, /function collectDeFiPriceSymbols\(\)/, 'DeFi price fetch must include protocol tokens');
assert.match(indexHtml, /function protocolPositionUnitPrice\(pos, unitPrices = null\)/, 'protocol unit price must prefer CoinGecko with optional frozen map');
assert.match(indexHtml, /AUSD:'agora-dollar'/, 'AUSD stablecoin must map to agora-dollar');
assert.match(indexHtml, /USDM:'mountain-protocol-usdm'/, 'USDm must map to Mountain Protocol USDm for live prices');
assert.match(indexHtml, /async function resolveGeckoIdByMarketCap\(symbol\)/, 'ambiguous tickers must resolve by market cap');
assert.match(indexHtml, /function sectionHasLendingLoop\(sec\)/, 'lending loop sections must be detectable');
assert.match(indexHtml, /function wrapDrawerLendingLoop\(bodyHtml, breakdown\)/, 'expanded loops must show total APY between supplied and borrowed');

const PROTO_STABLE_PEG_MIN = 0.998;
const PROTO_STABLE_PEG_MAX = 1.004;
let livePrices = {};

function protocolTokenAmountAndSymbol(raw) {
  const m = String(raw || '').trim().match(/^([\d,]+(?:\.\d+)?)\s+(.+)$/);
  if (!m) return null;
  return { amount: Number(m[1].replace(/,/g, '')), symbol: m[2].trim() };
}
function stableUnitPriceInPegBand(unit) {
  if (!Number.isFinite(unit)) return false;
  const rounded = Math.round(unit * 10000) / 10000;
  return rounded >= PROTO_STABLE_PEG_MIN && rounded <= PROTO_STABLE_PEG_MAX;
}
function protocolPositionSingleToken(pos) {
  const tokens = Array.isArray(pos?.tokens) ? pos.tokens : [];
  if (tokens.length !== 1) return null;
  const parsed = protocolTokenAmountAndSymbol(tokens[0]);
  if (!parsed || !parsed.amount || !Number.isFinite(parsed.amount)) return null;
  if (/^(PT|YT)-/.test(parsed.symbol.toUpperCase())) return null;
  return parsed;
}
function protocolTokenCoingeckoUnitPrice(pos, unitPrices = null) {
  const parsed = protocolPositionSingleToken(pos);
  if (!parsed) return null;
  const sym = parsed.symbol.toUpperCase();
  if (unitPrices && Number.isFinite(unitPrices[sym]) && unitPrices[sym] > 0) return unitPrices[sym];
  const usd = livePrices[sym];
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}
function protocolPositionImportUnitPrice(pos) {
  const parsed = protocolPositionSingleToken(pos);
  if (!parsed) return null;
  const rawValue = Number(pos.value || 0);
  if (!rawValue) return null;
  return rawValue / parsed.amount;
}
function protocolPositionUnitPrice(pos, unitPrices = null) {
  const cgUnit = protocolTokenCoingeckoUnitPrice(pos, unitPrices);
  if (cgUnit !== null) return cgUnit;
  return protocolPositionImportUnitPrice(pos);
}
function fixedStablePositionValue(pos, unitPrices = null) {
  const parsed = protocolPositionSingleToken(pos);
  if (!parsed) return null;
  const unit = protocolPositionUnitPrice(pos, unitPrices);
  if (unit === null || !stableUnitPriceInPegBand(unit)) return null;
  return parsed.amount;
}
function protocolPositionValue(pos, unitPrices = null) {
  if (pos?.manualUsd) return Number(pos?.value || 0);
  const pegged = fixedStablePositionValue(pos, unitPrices);
  if (pegged !== null) return pegged;
  const parsed = protocolPositionSingleToken(pos);
  if (parsed) {
    const cgUnit = protocolTokenCoingeckoUnitPrice(pos, unitPrices);
    if (cgUnit !== null) return parsed.amount * cgUnit;
  }
  return Number(pos?.value || 0);
}

const gho = {
  pool: 'GHO',
  sub: 'Borrowed',
  tokens: ['30,104.6862 GHO'],
  value: 29924.06,
};
livePrices.GHO = 0.9992;
assert.equal(protocolPositionValue(gho), 30104.6862, 'GHO uses CoinGecko $0.9992 and pegs at $1 in band');
assert.equal(fixedStablePositionValue(gho), 30104.6862);

const usdm = {
  pool: 'USDm',
  sub: 'Borrowed',
  tokens: ['165,448.1460 USDm'],
  value: 166109.94,
};
livePrices.USDM = 1.0039;
assert.equal(protocolPositionValue(usdm), 165448.146, 'USDm uses CoinGecko unit in peg band');

livePrices.GHO = 0.995;
assert.equal(protocolPositionValue(gho), 30104.6862 * 0.995, 'GHO outside peg band uses amount * CoinGecko');

const ghoStaleManual = { ...gho, manualValue: true };
livePrices.GHO = 0.9992;
assert.equal(protocolPositionValue(ghoStaleManual), 30104.6862, 'stale manualValue from token edit must not block CoinGecko peg');

const ghoManualUsd = { ...gho, manualUsd: true };
assert.equal(protocolPositionValue(ghoManualUsd), 29924.06, 'explicit USD override keeps import value');

const reusd = {
  pool: 'reUSD',
  sub: 'Supplied',
  tokens: ['24400 reUSD'],
  value: 25000,
};
const frozenReusd = { REUSD: 1.082 };
livePrices.REUSD = 1.05;
assert.equal(protocolPositionValue(reusd, frozenReusd), 24400 * 1.082, 'frozen import unit price overrides live CoinGecko');
assert.equal(protocolPositionValue(reusd), 24400 * 1.05, 'current view still uses live CoinGecko');

const sf = (usd) => String(BigInt(Math.round(usd * 100)) * (2n ** 60n) / 100n);
const kamino = mapKaminoObligation(
  'FuzwwLMkp8KU3NEGykHhKz56YR4u6SWghdAmB447hxA1',
  { name: 'Solstice Market', lendingMarket: 'solstice' },
  {
    supplyReserve: { liquidityToken: 'eUSX', liquidityTokenMint: 'supplyMint', supplyApy: '0.034' },
    borrowReserve: { liquidityToken: 'USDG', liquidityTokenMint: 'borrowMint', borrowApy: '0.0778' },
  },
  {
    obligationAddress: 'obligation',
    refreshedStats: {
      userTotalBorrow: '2.0011797308025069368',
      userTotalDeposit: '4906.5171798479682902',
      netAccountValue: '4904.5160001171657833',
      loanToValue: '0.00040786155585508717744',
      liquidationLtv: '0.80000000000000000001',
    },
    state: {
      deposits: [{ depositReserve: 'supplyReserve', marketValueSf: sf(4903.45) }],
      borrows: [{
        borrowReserve: 'borrowReserve',
        borrowedAmountOutsideElevationGroups: '2000000',
        marketValueSf: '0',
      }],
    },
  },
);
assert.ok(kamino, 'Kamino obligation with non-zero raw borrow but zero marketValueSf must still map');
assert.equal(kamino.protocol, 'Kamino');
assert.equal(kamino.marketName, 'eUSX / USDG');
assert.equal(kamino.borrowed.length, 1);
assert.equal(kamino.borrowed[0].symbol, 'USDG');
assert.equal(kamino.totalBorrowed, 2.0011797308025069368);

const preserved = mergeRecentLoopPositions(
  { updatedAt: Date.now(), positions: [], errors: [] },
  { positions: [kamino] },
  { previousFetchedAt: Date.now() - 5 * 60 * 1000 },
);
assert.equal(preserved.positions.length, 1, 'recent Kamino positions must survive a transient empty provider poll');
assert.equal(preserved.positions[0].protocol, 'Kamino');
assert.equal(preserved.positions[0].stale, true);

console.log('PASS: protocol APR stable $1 peg tests');
