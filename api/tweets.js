// =============================================================================
// /api/tweets.js
// GET /api/tweets?handle=justinsuntron
//
// Uses Twitter's Syndication API (the same one powering embedded timelines).
// Requires X session cookies stored as Vercel env vars — no paid API key needed.
//
// Setup:
//   1. Log into x.com in Chrome → F12 → Application → Cookies → x.com
//   2. Copy auth_token, ct0, guest_id, kdt
//   3. Add to Vercel: Settings → Environment Variables
// =============================================================================

export const maxDuration = 60;

const SYNDICATION_URL = 'https://syndication.twitter.com/srv/timeline-profile/screen-name';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

  const handle = (req.query?.handle || '')
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9_]/g, '');

  if (!handle) {
    return res.status(400).json({ error: 'Missing or invalid handle param' });
  }

  const { X_AUTH_TOKEN, X_CT0, X_GUEST_ID, X_KDT } = process.env;

  if (!X_AUTH_TOKEN || !X_CT0) {
    return res.status(500).json({
      error: 'Missing X_AUTH_TOKEN or X_CT0 env vars. See setup instructions in tweets.js.',
    });
  }

  const cookie = [
    `auth_token=${X_AUTH_TOKEN}`,
    `ct0=${X_CT0}`,
    X_GUEST_ID ? `guest_id=${X_GUEST_ID}` : '',
    X_KDT      ? `kdt=${X_KDT}`           : '',
  ].filter(Boolean).join('; ');

  try {
    const url = `${SYNDICATION_URL}/${handle}`;
    console.log(`[tweets] Fetching syndication for @${handle}`);

    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':      'application/json, text/javascript, */*; q=0.01',
        'Referer':     'https://platform.twitter.com/',
        'Origin':      'https://platform.twitter.com',
        'Cookie':      cookie,
      },
    });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[tweets] Syndication HTTP ${r.status}:`, body.slice(0, 200));
      return res.status(200).json({ handle, tweets: [], error: `Syndication API returned ${r.status}` });
    }

    const data = await r.json();

    // The syndication response wraps tweets under data.timeline.instructions
    const entries = data?.timeline?.instructions
      ?.flatMap(i => i.entries ?? [])
      ?.filter(e => e?.entryId?.startsWith('profile-grid-0-tweet-') || e?.entryId?.startsWith('tweet-'))
      ?? [];

    if (!entries.length) {
      console.warn('[tweets] No tweet entries in syndication response');
      return res.status(200).json({ handle, tweets: [], error: 'No tweets found in syndication response' });
    }

    const tweets = entries.slice(0, 3).map(entry => {
      const result  = entry?.content?.itemContent?.tweet_results?.result;
      const core    = result?.core?.user_results?.result?.legacy;
      const legacy  = result?.legacy ?? result?.tweet?.legacy;

      const text    = (legacy?.full_text ?? '')
        .replace(/https?:\/\/t\.co\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const tweetId = legacy?.id_str ?? '';
      const url     = tweetId
        ? `https://x.com/${handle}/status/${tweetId}`
        : `https://x.com/${handle}`;

      const rawDate = legacy?.created_at ?? '';
      const date    = rawDate
        ? new Date(rawDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';

      return { text, url, date };
    }).filter(t => t.text); // drop empty

    console.log(`[tweets] Returning ${tweets.length} tweet(s) for @${handle}`);
    return res.status(200).json({ handle, tweets });

  } catch (err) {
    console.error(`[tweets] Error for @${handle}:`, err.message);
    return res.status(200).json({ handle, tweets: [], error: err.message });
  }
}
