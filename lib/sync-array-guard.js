/**
 * Guards for /api/sync POST payloads.
 * Empty arrays are truthy in JS and must not overwrite KV keys accidentally.
 */

function shouldPersistSyncArray(value) {
  return Array.isArray(value) && value.length > 0;
}

/** Watcher wallets: persist non-empty lists, or empty when client explicitly clears. */
function shouldPersistWatcherWallets(wallets, body = {}) {
  if (!Array.isArray(wallets)) return false;
  if (wallets.length > 0) return true;
  return body.watcherWalletsClear === true;
}

function shouldPersistWatcherLinks(links, body = {}) {
  if (!Array.isArray(links)) return false;
  if (links.length > 0) return true;
  return body.watcherLinksClear === true;
}

module.exports = {
  shouldPersistSyncArray,
  shouldPersistWatcherWallets,
  shouldPersistWatcherLinks,
};
