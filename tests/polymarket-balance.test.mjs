import assert from 'node:assert/strict';
import {
  encodeBalanceOfData,
  hexToUsdcAmount,
  isWallet,
  PUSD,
  USDC_BRIDGED,
  USDC_NATIVE,
  fetchPolymarketWalletBalances,
} from '../lib/polymarket-balance.js';

assert.equal(isWallet('0x2ec0aa99d26b703585f58bded217a640d09e976b'), true);
assert.equal(isWallet('not-a-wallet'), false);

assert.equal(USDC_BRIDGED.length, 42);
assert.equal(USDC_NATIVE.length, 42);
assert.equal(PUSD.length, 42);

const wallet = '0x2ec0aa99d26b703585f58bded217a640d09e976b';
const data = encodeBalanceOfData(wallet);
assert.ok(data.startsWith('0x70a08231'));
assert.equal(data.length, 74);

assert.equal(hexToUsdcAmount('0x0'), 0);
assert.equal(hexToUsdcAmount('0xf4240'), 1);
assert.equal(hexToUsdcAmount('0x'), 0);

// Known PM wallet with idle pUSD collateral (v2) but zero legacy USDC balances.
const pmWallet = '0x553a95b3c1b474d6c4b2b48772a8152c25f3177f';
const live = await fetchPolymarketWalletBalances([pmWallet]);
assert.equal(live.wallets, 1, 'valid PM wallet must be queried');
assert.ok(live.total > 0, `PM idle collateral must be > 0 (got ${live.total})`);
assert.ok(live.balances[0].usdc > 0, `wallet row must include idle cash (got ${live.balances[0].usdc})`);

console.log(`polymarket-balance.test.mjs: ok (live idle cash $${live.total.toFixed(2)})`);
