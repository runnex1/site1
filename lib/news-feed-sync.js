/**
 * Merge helpers for vault:news_feed KV sync (server + client).
 */

function parseNewsFeedMeta(bundle) {
  return bundle?.meta && typeof bundle.meta === 'object' ? bundle.meta : {};
}

function sectionTs(meta, section) {
  return Number(meta?.[section]) || 0;
}

function mergeTimestampMaps(a, b) {
  const out = {};
  for (const [key, ts] of Object.entries({ ...(a || {}), ...(b || {}) })) {
    const prev = Number(out[key]) || 0;
    const next = Number(ts) || 0;
    if (next >= prev) out[key] = next;
  }
  return out;
}

function savedItemKey(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.kind === 'note' && item.id) return `note:${item.id}`;
  const url = String(item.url || '').trim();
  return url ? `story:${url}` : '';
}

function savedUpdatedAt(item) {
  if (!item) return 0;
  if (item.kind === 'note') return Number(item.updatedAt) || Number(item.createdAt) || 0;
  return Number(item.updatedAt) || Number(item.savedAt) || 0;
}

function mergeSavedLists(a, b, max = 200) {
  const byKey = new Map();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const key = savedItemKey(item);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || savedUpdatedAt(item) >= savedUpdatedAt(prev)) byKey.set(key, item);
  }
  return [...byKey.values()]
    .sort((x, y) => savedUpdatedAt(y) - savedUpdatedAt(x))
    .slice(0, max);
}

function mergeQuickLinks(a, b, max = 50) {
  const byKey = new Map();
  const keyOf = (item) => String(item?.id || item?.url || '').trim();
  const updatedAt = (item) => Number(item?.updatedAt) || Number(item?.addedAt) || 0;
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const key = keyOf(item);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || updatedAt(item) >= updatedAt(prev)) byKey.set(key, item);
  }
  return [...byKey.values()]
    .sort((x, y) => updatedAt(y) - updatedAt(x))
    .slice(0, max);
}

function mergeNewsFeedStores(local, server) {
  const l = local && typeof local === 'object' ? local : {};
  const s = server && typeof server === 'object' ? server : {};
  const lMeta = parseNewsFeedMeta(l);
  const sMeta = parseNewsFeedMeta(s);
  const sections = ['settings', 'saved', 'seen', 'hidden', 'kobeissi', 'quickLinks'];
  const out = { meta: {} };

  for (const section of sections) {
    const lTs = sectionTs(lMeta, section);
    const sTs = sectionTs(sMeta, section);
    if (section === 'saved') {
      out.saved = mergeSavedLists(l.saved, s.saved);
      out.meta.saved = Math.max(lTs, sTs, savedUpdatedAt(out.saved[0]));
    } else if (section === 'quickLinks') {
      out.quickLinks = mergeQuickLinks(l.quickLinks, s.quickLinks);
      out.meta.quickLinks = Math.max(lTs, sTs);
    } else if (section === 'seen' || section === 'hidden') {
      out[section] = mergeTimestampMaps(l[section], s[section]);
      out.meta[section] = Math.max(lTs, sTs);
    } else if (sTs > lTs) {
      out[section] = s[section];
      out.meta[section] = sTs;
    } else if (lTs > sTs) {
      out[section] = l[section];
      out.meta[section] = lTs;
    } else {
      out[section] = s[section] ?? l[section];
      out.meta[section] = Math.max(lTs, sTs);
    }
  }

  out.meta.updatedAt = Math.max(
    Number(lMeta.updatedAt) || 0,
    Number(sMeta.updatedAt) || 0,
    ...sections.map((section) => Number(out.meta[section]) || 0),
  );
  return out;
}

module.exports = {
  mergeNewsFeedStores,
  mergeSavedLists,
  mergeTimestampMaps,
};
