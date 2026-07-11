/**
 * Resolve Polymarket profile links and addresses to trading (proxy) wallets.
 */

const { isWallet, normalizeWallet, fetchGammaJson } = require('./polymarket-balance');

const GAMMA_PROFILE_URL = 'https://gamma-api.polymarket.com/public-profile';
const GAMMA_SEARCH_URL = 'https://gamma-api.polymarket.com/public-search';

function profileUrlFromUsername(username) {
  const name = String(username || '').trim();
  return name ? `https://polymarket.com/@${encodeURIComponent(name)}` : null;
}

function parsePolymarketProfileInput(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;

  if (isWallet(input)) {
    return { kind: 'address', value: normalizeWallet(input), profileUrl: null };
  }

  let text = input;
  try {
    if (/^https?:\/\//i.test(text) || /^polymarket\.com/i.test(text)) {
      if (!/^https?:\/\//i.test(text)) text = `https://${text.replace(/^\/\//, '')}`;
      const url = new URL(text);
      const host = url.hostname.replace(/^www\./i, '');
      if (host === 'polymarket.com') {
        const atMatch = url.pathname.match(/^\/@([^/]+)/i);
        if (atMatch) {
          const username = decodeURIComponent(atMatch[1]);
          return { kind: 'username', value: username, profileUrl: profileUrlFromUsername(username) };
        }
        const profileMatch = url.pathname.match(/^\/profile\/([^/]+)/i);
        if (profileMatch) {
          const segment = decodeURIComponent(profileMatch[1]);
          if (isWallet(segment)) {
            return { kind: 'address', value: normalizeWallet(segment), profileUrl: `${url.origin}${url.pathname}` };
          }
          return { kind: 'username', value: segment, profileUrl: profileUrlFromUsername(segment) };
        }
      }
    }
  } catch (e) {
    // Fall through to shorthand parsing.
  }

  if (input.startsWith('@')) {
    const username = input.slice(1).trim();
    if (username) return { kind: 'username', value: username, profileUrl: profileUrlFromUsername(username) };
  }

  if (/^[a-zA-Z0-9_-]{2,32}$/.test(input)) {
    return { kind: 'username', value: input, profileUrl: profileUrlFromUsername(input) };
  }

  return null;
}

async function fetchPublicProfileByAddress(address) {
  const addr = normalizeWallet(address);
  if (!isWallet(addr)) return null;
  try {
    const url = new URL(GAMMA_PROFILE_URL);
    url.searchParams.set('address', addr);
    return await fetchGammaJson(url, 8000);
  } catch (e) {
    return null;
  }
}

async function fetchProfileByUsername(username) {
  const q = String(username || '').trim();
  if (!q) return null;
  try {
    const url = new URL(GAMMA_SEARCH_URL);
    url.searchParams.set('q', q);
    url.searchParams.set('search_profiles', 'true');
    url.searchParams.set('search_tags', 'false');
    url.searchParams.set('limit_per_type', '10');
    const data = await fetchGammaJson(url, 8000);
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const lower = q.toLowerCase();
    const exact = profiles.find((p) => String(p?.name || '').toLowerCase() === lower);
    return exact || profiles[0] || null;
  } catch (e) {
    return null;
  }
}

function tradingWalletFromProfile(profile, fallbackAddress) {
  const proxy = normalizeWallet(profile?.proxyWallet);
  if (isWallet(proxy)) return proxy;
  const fallback = normalizeWallet(fallbackAddress);
  if (isWallet(fallback)) return fallback;
  return null;
}

async function resolvePolymarketProfile(input) {
  const parsed = parsePolymarketProfileInput(input);
  if (!parsed) {
    return { ok: false, error: 'Enter a 0x address or Polymarket profile link (@username).' };
  }

  if (parsed.kind === 'address') {
    const profile = await fetchPublicProfileByAddress(parsed.value);
    const proxyWallet = tradingWalletFromProfile(profile, parsed.value);
    if (!proxyWallet) {
      return { ok: false, error: 'Could not resolve Polymarket wallet for that address.' };
    }
    const name = String(profile?.name || '').trim() || null;
    const profileUrl = name ? profileUrlFromUsername(name) : (parsed.profileUrl || null);
    return {
      ok: true,
      proxyWallet,
      eoa: parsed.value,
      username: name,
      label: name,
      profileUrl,
    };
  }

  const profile = await fetchProfileByUsername(parsed.value);
  if (!profile) {
    return { ok: false, error: `No Polymarket profile found for "@${parsed.value}".` };
  }
  const proxyWallet = tradingWalletFromProfile(profile, null);
  if (!proxyWallet) {
    return { ok: false, error: `Profile "@${parsed.value}" has no trading wallet.` };
  }
  const name = String(profile?.name || parsed.value).trim();
  return {
    ok: true,
    proxyWallet,
    username: name,
    label: name,
    profileUrl: parsed.profileUrl || profileUrlFromUsername(name),
  };
}

module.exports = {
  profileUrlFromUsername,
  parsePolymarketProfileInput,
  resolvePolymarketProfile,
};
