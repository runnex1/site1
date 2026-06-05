/**
 * Debug closed-pair detection against live exchange data.
 * Usage: node scripts/closed-pairs-debug.mjs [wallet] [days]
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { fetchPerpsDashboard } = require(join(ROOT, 'lib', 'perps.js'));

const wallet = process.argv[2] || '0x2Ec0aa99D26b703585f58bdEd217a640d09e976b';
const days = Number(process.argv[3] || 30);
const grvtSubAccount = process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359';
const cutoff30d = Date.now() - 30 * 86400000;

async function main() {
  console.log(`Wallet: ${wallet}`);
  console.log(`Window: ${days}d | GRVT key: ${process.env.GRVT_API_KEY ? 'yes' : 'no'} | Extended key: ${process.env.EXTENDED_API_KEY ? 'yes' : 'no'}`);
  console.log('---');

  const dash = await fetchPerpsDashboard({
    hyperliquid: wallet,
    nado: wallet,
    grvtSubAccount,
    days,
  });

  console.log(`GRVT configured: ${dash.summary?.grvtConfigured ?? dash.grvt?.configured}`);
  console.log(`GRVT fills: ${dash.summary?.grvtFillsCount ?? dash.grvt?.fills?.fills?.length ?? 0} (raw ${dash.summary?.grvtFillsRawCount ?? '—'})`);
  console.log(`GRVT position history: ${dash.summary?.grvtPositionHistoryCount ?? '—'} (raw ${dash.summary?.grvtPositionHistoryRawCount ?? '—'})`);
  console.log(`GRVT error: ${dash.summary?.grvtError ?? dash.grvt?.fills?.error ?? '—'}`);
  console.log(`Extended configured: ${dash.summary?.extendedConfigured ?? dash.extended?.configured}`);
  console.log(`Dashboard closedPairs: ${dash.closedPairs?.length || 0}`);
  console.log(`Summary closedCount: ${dash.summary?.closedCount ?? '—'}`);

  const recent = (dash.closedPairs || []).filter(p => p.closeTime >= cutoff30d);
  console.log(`Closed pairs (last 30d): ${recent.length}`);
  for (const p of recent.slice(0, 25)) {
    console.log(`  ${p.symbol} ${p.pairLabel} close=${new Date(p.closeTime).toISOString().slice(0, 10)} net=${p.netPnl?.toFixed?.(2)}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
