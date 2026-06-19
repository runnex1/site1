import assert from 'node:assert/strict';
import {
  encodeBalanceOfData,
  hexToUsdcAmount,
  isWallet,
  USDC_BRIDGED,
  USDC_NATIVE,
} from '../lib/polymarket-balance.js';

assert.equal(isWallet('0x2ec0aa99d26b703585f58bded217a640d09e976b'), true);
assert.equal(isWallet('not-a-wallet'), false);

assert.equal(USDC_BRIDGED.length, 42);
assert.equal(USDC_NATIVE.length, 42);

const wallet = '0x2ec0aa99d26b703585f58bded217a640d09e976b';
const data = encodeBalanceOfData(wallet);
assert.ok(data.startsWith('0x70a08231'));
assert.equal(data.length, 74);

assert.equal(hexToUsdcAmount('0x0'), 0);
assert.equal(hexToUsdcAmount('0xf4240'), 1);
assert.equal(hexToUsdcAmount('0x'), 0);

console.log('polymarket-balance.test.mjs: ok');
