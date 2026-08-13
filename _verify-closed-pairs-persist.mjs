// Verify server-side closed-pair persistence logic: dedupe key, deleted-key
// filtering, 30d retention prune, merge quality.
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const sync = readFileSync('api/sync.js', 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
};

// --- server helpers present ---
ok('sync.js has closedPairMergeKey', /function closedPairMergeKey\(pair\)/.test(sync));
ok('sync.js has mergeClosedPairRows', /function mergeClosedPairRows\(/.test(sync));
ok('sync.js has pruneClosedPairRowsByAge', /function pruneClosedPairRowsByAge\(/.test(sync));
ok('sync.js GET perpsAux returns perpsClosedPairs', /const perpsClosedPairs = pruneClosedPairRowsByAge\(parseJson\(perpsClosedPairsRaw, \[\]\)\)/.test(sync));
ok('sync.js GET perpsAux returns deleted keys', /perpsClosedPairDeletedKeys: parseJson\(perpsClosedPairDeletedRaw, \[\]\)/.test(sync));
ok('sync.js POST handles perpsClosedPairs', /body\.perpsClosedPairs/.test(sync));
ok('sync.js POST handles perpsClosedPairDeletedKeys', /body\.perpsClosedPairDeletedKeys/.test(sync));
ok('sync.js retention 30d', /CLOSED_PAIR_RETENTION_MS = 30 \* 86400000/.test(sync));

// --- client helpers present ---
ok('index.html PERPS_CLOSED_PAIRS_KEY', /PERPS_CLOSED_PAIRS_KEY = 'vault-perps-closed-pairs'/.test(html));
ok('index.html perpsLoadClosedPairsRaw', /function perpsLoadClosedPairsRaw\(\)/.test(html));
ok('index.html perpsPersistClosedPairs', /function perpsPersistClosedPairs\(/.test(html));
ok('index.html perpsPushClosedPairsToServer', /function perpsPushClosedPairsToServer\(/.test(html));
ok('index.html perpsPushClosedPairDeletedKeysToServer', /function perpsPushClosedPairDeletedKeysToServer\(/.test(html));
ok('index.html perpsMergeClosedPairsFromServer', /function perpsMergeClosedPairsFromServer\(/.test(html));
ok('index.html perpsPruneClosedPairsByAge', /function perpsPruneClosedPairsByAge\(/.test(html));
ok('index.html 30d retention client', /PERPS_CLOSED_PAIR_RETENTION_MS = 30 \* 86400000/.test(html));
ok('index.html hydrate merges closed pairs', /perpsMergeClosedPairsFromServer\(body\.perpsClosedPairs\)/.test(html));
ok('index.html render merges persisted at start', /perpsLoadClosedPairsRaw\(\) \|\| \[\]/.test(html));
ok('index.html render persists after solo seeder', /perpsPersistClosedPairs\(\[\.\.\.(?:rawPersisted|perpsLoadClosedPairsRaw\(\))/.test(html));
ok('index.html delete pushes deleted keys', /perpsPushClosedPairDeletedKeysToServer\(deleted\)/.test(html));

// --- pure logic: dedupe + deleted + retention ---
const now = Date.now();
const day = 86400000;
const make = (symbol, closeTime, longVenue, shortVenue, extra = {}) => ({
  symbol, closeTime, longLeg: { venue: longVenue }, shortLeg: { venue: shortVenue }, ...extra,
});
const pairs = [
  make('XLM', now - 1 * day, 'variational', 'extended', { manualVariationalClose: true }),
  make('RENDER', now - 2 * day, 'hyperliquid', 'variational', { manualVariationalClose: true }),
  make('OLD', now - 40 * day, 'hyperliquid', 'variational', { manualVariationalClose: true }),
  make('XLM', now - 1 * day, 'variational', 'extended', { manualVariationalClose: true, funding: 5 }), // dup
];
// simulate mergeClosedPairRows
const deleted = [];
const keyOf = (p) => `${p.symbol}|${Number(p.closeTime) || 0}|${p.longLeg?.venue || ''}|${p.shortLeg?.venue || ''}`;
const byKey = new Map();
for (const p of pairs) {
  const k = keyOf(p);
  byKey.set(k, { ...byKey.get(k), ...p });
}
let merged = [...byKey.values()].filter((p) => !deleted.includes(keyOf(p)));
merged = merged.filter((p) => now - Number(p.closeTime || 0) <= 30 * day);
ok('dedupe by key collapses XLM dup (funding 5 wins)', merged.filter((p) => p.symbol === 'XLM').length === 1 && merged.find((p) => p.symbol === 'XLM').funding === 5);
ok('40d-old row pruned by retention', merged.filter((p) => p.symbol === 'OLD').length === 0);
ok('30d rows retained', merged.length === 2);

// deleted-key filtering
const del2 = new Set([keyOf(make('RENDER', now - 2 * day, 'hyperliquid', 'variational'))]);
const merged2 = merged.filter((p) => !del2.has(keyOf(p)));
ok('deleted key filters RENDER', merged2.filter((p) => p.symbol === 'RENDER').length === 0);

console.log(`\n===== RESULTS: ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
