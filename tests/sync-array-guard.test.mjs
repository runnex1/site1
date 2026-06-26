import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  shouldPersistSyncArray,
  shouldPersistWatcherWallets,
  shouldPersistWatcherLinks,
} = require('../lib/sync-array-guard.js');

const sampleWallet = { id: '1', address: '0x' + 'a'.repeat(40), label: 'test', category: 'yield' };

assert.equal(shouldPersistSyncArray([]), false, 'empty array must not persist');
assert.equal(shouldPersistSyncArray(['0xabc']), true, 'non-empty array must persist');
assert.equal(shouldPersistSyncArray(null), false);
assert.equal(shouldPersistSyncArray(undefined), false);

assert.equal(shouldPersistWatcherWallets([]), false, 'empty watcher list without clear must not persist');
assert.equal(shouldPersistWatcherWallets([], { watcherWalletsClear: true }), true, 'explicit clear must persist empty');
assert.equal(shouldPersistWatcherWallets([sampleWallet]), true, 'non-empty watcher list must persist');

assert.equal(shouldPersistWatcherLinks([]), false);
assert.equal(shouldPersistWatcherLinks([], { watcherLinksClear: true }), true);
assert.equal(shouldPersistWatcherLinks([{ id: '1', url: 'https://example.com' }]), true);

console.log('sync-array-guard.test.mjs: ok');
