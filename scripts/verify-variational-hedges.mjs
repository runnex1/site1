import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROD = 'https://testedefi.vercel.app';
const WALLET = '0x523c4fD04438aAB5e96CADCcDC92c855390Fb459';

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const html = await fetchText(`${PROD}/`);
check('production has reapply hook', html.includes('perpsReapplyVariationalHedgesIfMounted'));
check('production waits for boot promise', html.includes('_perpsBootPromise'));
check('VariationalHedge loads in browser', html.includes('lib/variational-hedge.js'));
check('production has closed-vs-reopen merge guard', html.includes('newerCleanReopen && (!eitherClosed || (!preferPrev && incTs > prevTs))'));

const sync = await fetchJson(`${PROD}/api/sync?portfolioOnly=1`);
const portfolio = JSON.parse(sync.result);
const hedges = portfolio._perpsVariationalHedges || [];
check('portfolioOnly returns hedges', hedges.length >= 3, `count=${hedges.length}`);

const open = hedges.filter((h) => h.status === 'open' && !h.supersededByLiveCross);
check('has open non-superseded Var hedges', open.length >= 1, `found=${open.map((h) => h.symbol).join(',')}`);

const zombieFlat = open.filter((h) => ['HBAR'].includes(h.symbol) && h.trackedVenue === 'grvt');
check('no HBAR GRVT open zombie after deploy', zombieFlat.length === 0, `zombies=${zombieFlat.map((h) => h.id).join(',')}`);

let perps;
try {
  perps = JSON.parse(readFileSync(join(ROOT, '..', '_live-perps.json'), 'utf8'));
} catch {
  perps = await fetchJson(`${PROD}/api/perps?wallet=${WALLET}&days=30`);
}

const { createRequire } = await import('module');
const require = createRequire(import.meta.url);
const { applyVariationalHedges } = require(join(ROOT, '..', 'lib/variational-hedge.js'));
const result = applyVariationalHedges(perps, open, {});
const paired = result.paired.filter((p) => p.variationalHedgeId).map((p) => p.symbol).sort();
const stillOpen = (result.hedges || []).filter((h) => h.status === 'open' && !h.supersededByLiveCross);
const leaked = result.unhedged
  .filter((u) => stillOpen.some((h) => h.symbol === u.symbol && h.trackedVenue === u.venue))
  .map((u) => `${u.symbol}@${u.venue}`)
  .sort();

check('apply builds at least one HL/GRVT+Var pair', paired.length >= 1, `paired=${paired.join(',')}`);
check('apply hides hedged legs from unhedged', leaked.length === 0, `leaked=${leaked.join(',')}`);

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} production verification checks passed.`);
