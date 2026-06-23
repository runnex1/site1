import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { protocolSectionKeyPrefix, protocolPositionKey } = require('../lib/defi-protocol-keys.js');

const fluid = {
  name: 'Fluid',
  sections: [
    { type: 'Lending', positions: [{ sub: 'supplied', pool: 'reUSD' }, { sub: 'borrowed', pool: 'USDC' }] },
    { type: 'Lending', positions: [{ sub: 'supplied', pool: 'reUSD' }, { sub: 'borrowed', pool: 'USDT' }] },
    { type: 'Lending', positions: [{ sub: 'supplied', pool: 'reUSD' }, { sub: 'borrowed', pool: 'GHO' }] },
  ],
};

const filteredCopies = fluid.sections.map((sec, sectionIndex) => ({ ...sec, sectionIndex }));

assert.equal(protocolSectionKeyPrefix(fluid, fluid.sections[0]), 'Fluid|||Lending');
assert.equal(protocolSectionKeyPrefix(fluid, fluid.sections[1]), 'Fluid|||Lending[2]');
assert.equal(protocolSectionKeyPrefix(fluid, fluid.sections[2]), 'Fluid|||Lending[3]');

assert.equal(protocolSectionKeyPrefix(fluid, filteredCopies[0]), 'Fluid|||Lending');
assert.equal(protocolSectionKeyPrefix(fluid, filteredCopies[1]), 'Fluid|||Lending[2]');
assert.equal(protocolSectionKeyPrefix(fluid, filteredCopies[2]), 'Fluid|||Lending[3]');

assert.equal(
  protocolPositionKey(fluid, filteredCopies[1], { sub: 'supplied', pool: 'reUSD' }),
  'Fluid|||Lending[2]:supplied:reUSD',
);

console.log('defi-protocol-keys.test.mjs: ok');
