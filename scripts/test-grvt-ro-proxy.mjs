/**
 * Verify GRVT auth works through the configured Romania proxy.
 * Usage: GRVT_API_KEY=... [GRVT_PROXY_URL=...|WEBSHARE_API_KEY=...] node scripts/test-grvt-ro-proxy.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGrvtProxyMeta } = require(join(ROOT, 'lib', 'grvt-proxy.js'));
const { fetchGrvtState } = require(join(ROOT, 'lib', 'perps.js'));

const subAccountId = process.argv[2] || process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359';

async function main() {
  if (!process.env.GRVT_API_KEY) {
    console.error('GRVT_API_KEY is required');
    process.exit(1);
  }

  const proxy = await resolveGrvtProxyMeta();
  const maskedUrl = proxy.url
    ? proxy.url.replace(/:([^:@/]+)@/, ':***@')
    : '(direct — no proxy configured)';
  console.log(`Proxy: ${maskedUrl} | source=${proxy.source} | country=${proxy.country}`);

  const state = await fetchGrvtState(subAccountId);
  const ip = (state.positions || []).find(p => p.symbol === 'IP');
  console.log(`GRVT state: configured=${state.configured} error=${state.error || 'none'} positions=${state.positions?.length || 0}`);
  if (ip) console.log(`IP position: ${ip.side} ${ip.size}`);
  if (state.error) process.exit(2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
