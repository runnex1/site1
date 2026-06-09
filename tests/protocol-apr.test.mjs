import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(indexHtml, /const GECKO_SYMBOL_IDS = \{/, 'CoinGecko symbol map must exist');
assert.match(indexHtml, /function geckoIdForSymbol\(symbol\)/, 'CoinGecko id resolver must exist');
assert.match(indexHtml, /function protocolTokenCoingeckoUnitPrice\(pos\)/, 'protocol positions must read CoinGecko prices');
assert.match(indexHtml, /function collectDeFiPriceSymbols\(\)/, 'DeFi price fetch must include protocol tokens');
assert.match(indexHtml, /function protocolPositionUnitPrice\(pos\)/, 'protocol unit price must prefer CoinGecko');
assert.match(indexHtml, /AUSD:'agora-dollar'/, 'AUSD stablecoin must map to agora-dollar');
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
function protocolTokenCoingeckoUnitPrice(pos) {
  const parsed = protocolPositionSingleToken(pos);
  if (!parsed) return null;
  const usd = livePrices[parsed.symbol.toUpperCase()];
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}
function protocolPositionImportUnitPrice(pos) {
  const parsed = protocolPositionSingleToken(pos);
  if (!parsed) return null;
  const rawValue = Number(pos.value || 0);
  if (!rawValue) return null;
  return rawValue / parsed.amount;
}
function protocolPositionUnitPrice(pos) {
  const cgUnit = protocolTokenCoingeckoUnitPrice(pos);
  if (cgUnit !== null) return cgUnit;
  return protocolPositionImportUnitPrice(pos);
}
function fixedStablePositionValue(pos) {
  const parsed = protocolPositionSingleToken(pos);
  if (!parsed) return null;
  const unit = protocolPositionUnitPrice(pos);
  if (unit === null || !stableUnitPriceInPegBand(unit)) return null;
  return parsed.amount;
}
function protocolPositionValue(pos) {
  if (pos?.manualUsd) return Number(pos?.value || 0);
  const pegged = fixedStablePositionValue(pos);
  if (pegged !== null) return pegged;
  const parsed = protocolPositionSingleToken(pos);
  if (parsed) {
    const cgUnit = protocolTokenCoingeckoUnitPrice(pos);
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

console.log('PASS: protocol APR stable $1 peg tests');
