/**
 * Probe GRVT fill_history + position_history (first page only).
 * Usage: GRVT_API_KEY=... node scripts/grvt-probe.mjs [subAccountId] [days]
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  fetchGrvtFills,
  fetchGrvtPositionHistory,
  fetchGrvtFunding,
} = require(join(ROOT, 'lib', 'perps.js'));

const subAccountId = process.argv[2] || process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359';
const days = Number(process.argv[3] || 30);

async function main() {
  if (!process.env.GRVT_API_KEY) {
    console.error('GRVT_API_KEY is required');
    process.exit(1);
  }
  console.log(`Sub-account: ${subAccountId} | window: ${days}d`);
  const [fills, history, funding] = await Promise.all([
    fetchGrvtFills(subAccountId, days),
    fetchGrvtPositionHistory(subAccountId, days),
    fetchGrvtFunding(subAccountId, days),
  ]);
  console.log('---');
  console.log(`funding payments: ${funding.payments?.length || 0}${funding.error ? ` error=${funding.error}` : ''}`);
  console.log(`fill_history raw: ${fills.rawRowCount ?? '—'} mapped: ${fills.fills?.length || 0}${fills.error ? ` error=${fills.error}` : ''}`);
  console.log(`position_history raw: ${history.rawRowCount ?? '—'} closed: ${history.positions?.length || 0}${history.error ? ` error=${history.error}` : ''}`);
  if (fills.fills?.[0]) console.log('sample fill:', fills.fills[0]);
  if (history.positions?.[0]) console.log('sample position:', history.positions[0]);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
