import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(indexHtml, /const PROTO_STABLE_PEG_MIN = 0\.998;/, 'stable peg min must be 0.998');
assert.match(indexHtml, /const PROTO_STABLE_PEG_MAX = 1\.004;/, 'stable peg max must be 1.004');
assert.match(indexHtml, /function protocolTokenDisplayText\(pos, tokenText\)/, 'pegged protocol tokens must render amount-only');
assert.match(indexHtml, /function protocolImportPositionMap\(entry\)/, 'APR must rebuild snapshot maps from protocols when available');
assert.doesNotMatch(indexHtml, /if \(isUsdPegStableSymbol\(parsed\.symbol\)\) return parsed\.amount;/, 'peg must not bypass unit-price band by symbol');

const PROTO_STABLE_PEG_MIN = 0.998;
const PROTO_STABLE_PEG_MAX = 1.004;

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
function protocolTokenDisplayText(pos, tokenText) {
  const parsed = protocolTokenAmountAndSymbol(tokenText);
  if (!parsed) return tokenText;
  const amountMatch = String(tokenText || '').trim().match(/^([\d,]+(?:\.\d+)?)/);
  const amountStr = amountMatch ? amountMatch[1] : String(parsed.amount);
  if (fixedStablePositionValue(pos) !== null) return amountStr;
  const poolSym = String(pos?.pool || '').trim().toUpperCase();
  const tokenSym = parsed.symbol.toUpperCase();
  if (poolSym && (poolSym === tokenSym || poolSym.startsWith(tokenSym) || tokenSym.startsWith(poolSym))) {
    return amountStr;
  }
  return tokenText;
}

const usdm = {
  pool: 'USDm',
  sub: 'Borrowed',
  tokens: ['165,448.1460 USDm'],
  value: 166109.94,
};
const gho = {
  pool: 'GHO',
  sub: 'Borrowed',
  tokens: ['30,104.6862 GHO'],
  value: 29924.06,
};

assert.equal(protocolPositionValue(usdm), 165448.146, 'USDm near $1 import must peg to token count');
assert.equal(protocolTokenDisplayText(usdm, usdm.tokens[0]), '165,448.1460');
assert.equal(protocolTokenDisplayText(gho, gho.tokens[0]), '30,104.6862');

const olderUsdm = { pool: 'USDm', tokens: ['165,410.9958 USDm'], value: 165178.26 };
const days = 1.803;
const delta = protocolPositionValue(usdm) - protocolPositionValue(olderUsdm);
const apr = (delta / protocolPositionValue(olderUsdm)) * (365 / days) * 100;
assert.ok(Math.abs(delta - 37.15) < 1, `USDm delta should be modest token accrual, got ${delta}`);
assert.ok(apr > 0 && apr < 15, `USDm borrow APR should be modest, got ${apr.toFixed(1)}%`);

console.log('PASS: protocol APR stable $1 peg tests');
