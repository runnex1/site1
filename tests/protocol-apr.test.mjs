import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(indexHtml, /const PROTO_STABLE_PEG_MIN = 0\.998;/, 'stable peg min must be 0.998');
assert.match(indexHtml, /const PROTO_STABLE_PEG_MAX = 1\.0032;/, 'stable peg max must be 1.0032');
assert.match(indexHtml, /function stableUnitPriceInPegBand\(unit\)/, 'stable peg must use shared unit-price band helper');
assert.match(indexHtml, /function protocolImportPositionMap\(entry\)/, 'APR must rebuild snapshot maps from protocols when available');
assert.doesNotMatch(indexHtml, /if \(isUsdPegStableSymbol\(parsed\.symbol\)\) return parsed\.amount;/, 'peg must not bypass unit-price band by symbol');

const PROTO_STABLE_PEG_MIN = 0.998;
const PROTO_STABLE_PEG_MAX = 1.0032;

function protocolTokenAmountAndSymbol(raw) {
  const m = String(raw || '').trim().match(/^([\d,]+(?:\.\d+)?)\s+(.+)$/);
  if (!m) return null;
  return { amount: Number(m[1].replace(/,/g, '')), symbol: m[2].trim() };
}
function stableUnitPriceInPegBand(unit) {
  return Number.isFinite(unit) && unit >= PROTO_STABLE_PEG_MIN && unit <= PROTO_STABLE_PEG_MAX;
}
function fixedStablePositionValue(pos) {
  if (pos?.manualValue) return null;
  const tokens = Array.isArray(pos?.tokens) ? pos.tokens : [];
  if (tokens.length !== 1) return null;
  const parsed = protocolTokenAmountAndSymbol(tokens[0]);
  if (!parsed || !parsed.amount || !Number.isFinite(parsed.amount)) return null;
  if (/^(PT|YT)-/.test(parsed.symbol.toUpperCase())) return null;
  const rawValue = Number(pos.value || 0);
  const unit = rawValue / parsed.amount;
  return stableUnitPriceInPegBand(unit) ? parsed.amount : null;
}
function protocolPositionValue(pos) {
  const fixed = fixedStablePositionValue(pos);
  return fixed !== null ? fixed : Number(pos?.value || 0);
}

const inBandGho = {
  pool: 'GHO',
  tokens: ['30,090.9082 GHO'],
  value: 30042.76,
};
const outBandGho = {
  pool: 'GHO',
  tokens: ['30,104.6862 GHO'],
  value: 29924.06,
};
const outBandHigh = {
  pool: 'USDC',
  tokens: ['1,000 USDC'],
  value: 1004.5,
};

assert.equal(protocolPositionValue(inBandGho), 30090.9082, 'in-band stable uses token count as USD');
assert.equal(protocolPositionValue(outBandGho), 29924.06, 'below-band import keeps raw USD value');
assert.equal(protocolPositionValue(outBandHigh), 1004.5, 'above-band import keeps raw USD value');
assert.equal(stableUnitPriceInPegBand(1.0032), true);
assert.equal(stableUnitPriceInPegBand(1.0033), false);
assert.equal(stableUnitPriceInPegBand(0.9979), false);

console.log('PASS: protocol APR stable $1 peg tests');
