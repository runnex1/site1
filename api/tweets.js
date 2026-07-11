"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = handler;
exports.maxDuration = void 0;
// =============================================================================
// /api/tweets.js
// GET /api/tweets?channel=kobeissiletters
//
// Fetches the 10 latest posts from a public Telegram channel.
// No API key, no cookies, no authentication required.
// Uses Telegram's public web view (t.me/s/channelname).
// =============================================================================

const maxDuration = exports.maxDuration = 15;
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  const channel = (req.query?.channel || req.query?.handle || '').trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!channel) {
    return res.status(400).json({
      error: 'Missing or invalid channel param'
    });
  }
  try {
    const url = `https://t.me/s/${channel}`;
    console.log(`[telegram] Fetching ${url}`);
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!r.ok) {
      return res.status(200).json({
        channel,
        posts: [],
        error: `Telegram returned HTTP ${r.status}`
      });
    }
    const html = await r.text();

    // Extract all message blocks
    const messageBlocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)].map(m => m[0]);
    if (!messageBlocks.length) {
      return res.status(200).json({
        channel,
        posts: [],
        error: 'No messages found'
      });
    }
    const posts = messageBlocks.slice(-30) // work from the most recent end
    .reverse().reduce((acc, block) => {
      if (acc.length >= 10) return acc;

      // Extract text — strip all HTML tags
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (!textMatch) return acc; // skip forwarded/media-only posts

      const rawText = textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : `&#${n};`;
      }).replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        const code = parseInt(h, 16);
        return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : `&#x${h};`;
      }).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
      if (!rawText) return acc;

      // Extract URL from the message date/time link
      const urlMatch = block.match(/href="(https:\/\/t\.me\/[^"]+\/(\d+))"/);
      const postUrl = urlMatch ? urlMatch[1] : `https://t.me/${channel}`;

      // Extract date from <time datetime="...">
      const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
      const publishedAt = dateMatch ? dateMatch[1] : '';
      if (!publishedAt) return acc;
      const publishedDate = publishedAt ? new Date(publishedAt) : null;
      if (!publishedDate || !Number.isFinite(publishedDate.getTime())) return acc;
      const date = publishedDate ? publishedDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      }) : '';
      const time = publishedDate ? publishedDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      }) : '';
      acc.push({
        text: rawText,
        url: postUrl,
        date,
        time,
        publishedAt
      });
      return acc;
    }, []);
    if (!posts.length) {
      return res.status(200).json({
        channel,
        posts: [],
        error: 'Could not parse any posts'
      });
    }
    console.log(`[telegram] Returning ${posts.length} post(s) for @${channel}`);
    return res.status(200).json({
      channel,
      posts
    });
  } catch (err) {
    console.error(`[telegram] Error for ${channel}:`, err.message);
    return res.status(200).json({
      channel,
      posts: [],
      error: err.message
    });
  }
}
//# sourceMappingURL=tweets.js.map