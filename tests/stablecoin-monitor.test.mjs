import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(indexHtml, /stablecoinAddModal/, 'stablecoin add modal must exist');
assert.match(indexHtml, /geckoPickModal/, 'gecko pick modal must exist');
assert.match(indexHtml, /stablecoinMonitors/, 'stablecoin monitors must persist in portfolio data');
assert.match(indexHtml, /function stablecoinSubmitAdd\(/, 'stablecoin submit handler must exist');
assert.match(indexHtml, /function resolveGeckoIdCandidates\(/, 'multi-match resolver must exist');
assert.match(indexHtml, /function resolveGeckoFromContract\(/, 'contract resolver must exist');
assert.match(indexHtml, /stablecoinMonitorGeckoId\(token\)/, 'must normalize CoinGecko id field');
assert.match(indexHtml, /pegDiff = Number\.isFinite\(cgPrice\) \? \(\(cgPrice - 1\) \* 100\)/, 'peg must use CoinGecko price not portfolio unit');
assert.match(indexHtml, /onclick="openModal\('stablecoinAdd'\)"/, 'stablecoin panel must expose add control');

console.log('PASS: stablecoin monitor tests');
