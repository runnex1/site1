import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(indexHtml, /function isUsdPegStableSymbol\(sym\)/, 'USD-pegged stable symbol helper must exist');
assert.match(indexHtml, /function protocolImportPositionMap\(entry\)/, 'APR must rebuild snapshot maps from protocols when available');
assert.match(indexHtml, /if \(isUsdPegStableSymbol\(parsed\.symbol\)\) return parsed\.amount;/, 'GHO and other stables must use $1 rule regardless of import unit price');

function protocolTokenAmountAndSymbol(raw) {
  const m = String(raw || '').trim().match(/^([\d,]+(?:\.\d+)?)\s+(.+)$/);
  if (!m) return null;
  return { amount: Number(m[1].replace(/,/g, '')), symbol: m[2].trim() };
}
function isUsdPegStableSymbol(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (!s || /^(PT|YT)-/.test(s)) return false;
  return /(USD|DAI|FRAX|LUSD|GHO|SUSDE|USDE|USDS|USDM|EURC|FDUSD|PYUSD|USD0|USDT0|USDC)/i.test(s);
}
function fixedStablePositionValue(pos) {
  if (pos?.manualValue) return null;
  const tokens = Array.isArray(pos?.tokens) ? pos.tokens : [];
  if (tokens.length !== 1) return null;
  const parsed = protocolTokenAmountAndSymbol(tokens[0]);
  if (!parsed || !parsed.amount || !Number.isFinite(parsed.amount)) return null;
  if (/^(PT|YT)-/.test(parsed.symbol.toUpperCase())) return null;
  if (isUsdPegStableSymbol(parsed.symbol)) return parsed.amount;
  const rawValue = Number(pos.value || 0);
  const unit = rawValue / parsed.amount;
  return unit >= 0.998 && unit <= 1.004 ? parsed.amount : null;
}
function protocolPositionValue(pos) {
  const fixed = fixedStablePositionValue(pos);
  return fixed !== null ? fixed : Number(pos?.value || 0);
}

const olderGho = {
  pool: 'GHO',
  sub: 'Borrowed',
  tokens: ['30,090.9082 GHO'],
  value: 30042.76,
};
const newerGho = {
  pool: 'GHO',
  sub: 'Borrowed',
  tokens: ['30,104.6862 GHO'],
  value: 29924.06,
};

const olderVal = protocolPositionValue(olderGho);
const newerVal = protocolPositionValue(newerGho);
const delta = newerVal - olderVal;
const days = 1.803;
const apr = ((delta / olderVal) * (365 / days)) * 100;

assert.equal(olderVal, 30090.9082, 'older GHO should use $1 token count');
assert.equal(newerVal, 30104.6862, 'newer GHO should use $1 token count even when import unit < 0.998');
assert.ok(Math.abs(delta - 13.778) < 0.01, 'GHO delta should match token accrual (~13.78)');
assert.ok(apr > 0 && apr < 15, `annualized GHO borrow APR should be modest, got ${apr.toFixed(2)}%`);

console.log('PASS: protocol APR stable $1 peg tests');
