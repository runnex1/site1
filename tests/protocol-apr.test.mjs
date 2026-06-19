import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  protocolAprDaysDiff,
  protocolPositionValuesEqual,
  calcPositionAprFromValues,
} = require('../lib/protocol-apr.js');

assert.equal(protocolPositionValuesEqual(10000, 10000), true);
assert.equal(protocolPositionValuesEqual(10000, 10000.5), true);
assert.equal(protocolPositionValuesEqual(10000, 10002), false);

assert.equal(calcPositionAprFromValues(10000, 10000, 1), 0);
assert.equal(calcPositionAprFromValues(10000, 10000.25, 1), 0);

const apr = calcPositionAprFromValues(10010, 10000, 1, 700, 500);
assert.ok(Math.abs(apr - 36.5) < 0.01, `expected ~36.5% APR, got ${apr}`);

const shortGapDays = protocolAprDaysDiff(Date.now() - 3600000, Date.now());
assert.equal(shortGapDays, 1, 'imports within 8h must use 24h APR floor');

console.log('protocol-apr.test.mjs: ok');
