/**
 * Seed server KV with last-known GRVT positions (for Vercel geo-block fallback).
 * Run with live API: GRVT_API_KEY=... node scripts/seed-grvt-cache.mjs
 * Or from saved dashboard JSON: node scripts/seed-grvt-cache.mjs _prod-perps-check.json
 */
import { readFileSync } from 'node:fs';
import { fetchGrvtState } from '../lib/perps.js';

const subAccount = process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359';
const syncUrl = process.env.SYNC_URL || 'https://testedefi.vercel.app/api/sync';
const fileArg = process.argv[2];

async function fromLiveApi() {
  const state = await fetchGrvtState(subAccount);
  if (!state?.positions?.length) throw new Error(state?.error || 'No GRVT positions from API');
  return {
    subAccountId: subAccount,
    fetchedAt: state.fetchedAt || Date.now(),
    accountValue: state.accountValue || 0,
    positions: state.positions,
  };
}

function fromJsonFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const state = raw?.grvt?.state || raw;
  const positions = state?.positions;
  if (!Array.isArray(positions) || !positions.length) {
    throw new Error(`No grvt.state.positions in ${path}`);
  }
  return {
    subAccountId: state.subAccountId || subAccount,
    fetchedAt: state.fetchedAt || raw.fetchedAt || Date.now(),
    accountValue: state.accountValue || 0,
    positions,
  };
}

const cache = fileArg ? fromJsonFile(fileArg) : await fromLiveApi();
const res = await fetch(syncUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grvtStateCache: cache }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
console.log('Seeded GRVT cache:', cache.subAccountId, cache.positions.map(p => `${p.symbol} ${p.side} ${p.size}`).join(', '));
