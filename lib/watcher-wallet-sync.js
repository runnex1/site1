/**
 * Merge watcher wallet lists for server sync (newest addedAt wins per stable key).
 */

function watcherWalletMergeKey(item) {
  if (!item || typeof item !== 'object') return '';
  const cat = String(item.category || '').toLowerCase();
  if (cat === 'pm') {
    const src = String(item.sourceInput || item.profileUrl || '').trim().toLowerCase();
    if (src) return `pm:${src}`;
    const id = String(item.id || '').trim();
    if (id) return `pm:id:${id}`;
  }
  const addr = String(item.address || '').toLowerCase();
  if (!addr) return '';
  return `${addr}|${cat}`;
}

function mergeWatcherWalletsForSync(local, server) {
  const byKey = new Map();
  for (const item of [...(Array.isArray(local) ? local : []), ...(Array.isArray(server) ? server : [])]) {
    const key = watcherWalletMergeKey(item);
    if (!key) continue;
    const ts = Number(item.addedAt) || 0;
    const prev = byKey.get(key);
    if (!prev || ts >= Number(prev.addedAt) || 0) byKey.set(key, item);
  }
  return [...byKey.values()];
}

module.exports = { watcherWalletMergeKey, mergeWatcherWalletsForSync };
