/**
 * Merge watcher wallet lists for server sync (newest addedAt wins per address|category).
 */

function mergeWatcherWalletsForSync(local, server) {
  const byKey = new Map();
  for (const item of [...(Array.isArray(local) ? local : []), ...(Array.isArray(server) ? server : [])]) {
    if (!item || typeof item !== 'object') continue;
    const key = `${String(item.address || '').toLowerCase()}|${String(item.category || '').toLowerCase()}`;
    if (!key || key === '|') continue;
    const ts = Number(item.addedAt) || 0;
    const prev = byKey.get(key);
    if (!prev || ts >= Number(prev.addedAt) || 0) byKey.set(key, item);
  }
  return [...byKey.values()];
}

module.exports = { mergeWatcherWalletsForSync };
