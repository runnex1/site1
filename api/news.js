// Vercel serverless function: fetch RSS headlines + rank with Groq AI
// GET /api/news?x=handle1,handle2  — returns pre-ranked news JSON, cached 2h on CDN edge
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Do NOT use s-maxage — Vercel's CDN would cache /api/news and serve that
    // same response for /api/news?x=handle1, ignoring the query string entirely.
    // Per-handle responses are marked private so Vercel's CDN never coalesces them.
    const xParam = req.query?.x || '';
    res.setHeader(
        'Cache-Control',
        xParam ? 'private, max-age=300' : 'public, max-age=7200'
    );

    const GROQ_KEY = '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';

    const SOURCES = [
        { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',  type: 'crypto', label: 'CoinDesk'      },
        { url: 'https://cointelegraph.com/rss',                    type: 'crypto', label: 'CoinTelegraph' },
        { url: 'https://thedefiant.io/feed',                       type: 'defi',   label: 'The Defiant'  },
        { url: 'https://blockworks.co/feed',                       type: 'defi',   label: 'Blockworks'   },
        { url: 'https://dlnews.com/rss.xml',                       type: 'defi',   label: 'DL News'      },
        { url: 'https://feeds.reuters.com/reuters/businessNews',   type: 'macro',  label: 'Reuters'      },
        { url: 'https://feeds.reuters.com/reuters/topNews',        type: 'macro',  label: 'Reuters'      },
    ];

    // ── Parse X handles from ?x= query param ───────────────────────────────
    const xHandles = xParam
        .split(',')
        .map(h => h.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, ''))
        .filter(Boolean)
        .slice(0, 10); // hard cap at 10

    // Nitter instances to try in order if the first fails
    const NITTER_INSTANCES = [
        'https://nitter.net',
        'https://nitter.privacydev.net',
        'https://nitter.poast.org',
    ];

    // ── Fetch + parse one RSS feed ──────────────────────────────────────────
    async function fetchFeed(src) {
        const r = await fetch(src.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();

        const items = [];
        const itemRe = /<item>([\s\S]*?)<\/item>/gi;
        let match;
        while ((match = itemRe.exec(text)) !== null && items.length < 5) {
            const block = match[1];
            const tag = (name) => {
                const m = block.match(new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>`, 'i'))
                       || block.match(new RegExp(`<${name}[^>]*>([^<]*)<\\/${name}>`, 'i'));
                return m ? m[1].trim() : '';
            };
            const title = tag('title');
            let link = tag('link');
            if (!link) link = tag('guid');
            if (title && link) items.push({ title, link, type: src.type, source: src.label });
        }
        return items;
    }

    // ── Fetch Nitter RSS for one X handle (tries multiple instances) ────────
    async function fetchNitter(handle) {
        for (const instance of NITTER_INSTANCES) {
            try {
                const url = `${instance}/${handle}/rss`;
                const r = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
                    signal: AbortSignal.timeout(8000),
                });
                if (!r.ok) continue;
                const text = await r.text();

                const items = [];
                const itemRe = /<item>([\s\S]*?)<\/item>/gi;
                let match;
                while ((match = itemRe.exec(text)) !== null && items.length < 3) {
                    const block = match[1];
                    const tag = (name) => {
                        const m = block.match(new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>`, 'i'))
                               || block.match(new RegExp(`<${name}[^>]*>([^<]*)<\\/${name}>`, 'i'));
                        return m ? m[1].trim() : '';
                    };
                    const title = tag('title');
                    let link = tag('link') || tag('guid');
                    // Rewrite Nitter links to x.com
                    if (link) link = link.replace(/^https?:\/\/nitter\.[^/]+\//, 'https://x.com/');
                    if (title && link) {
                        items.push({ title, link, type: 'x', source: `@${handle}` });
                    }
                }
                if (items.length) return items; // success — stop trying instances
            } catch(e) {
                // try next instance
            }
        }
        return []; // all instances failed
    }

    // ── Fetch all RSS feeds + Nitter feeds in parallel ──────────────────────
    const [settledFeeds, settledNitter] = await Promise.all([
        Promise.allSettled(SOURCES.map(fetchFeed)),
        Promise.allSettled(xHandles.map(fetchNitter)),
    ]);

    const allHeadlines = settledFeeds.flatMap(s => s.status === 'fulfilled' ? s.value : []);
    const xPosts       = settledNitter.flatMap(s => s.status === 'fulfilled' ? s.value : []);

    if (!allHeadlines.length && !xPosts.length) {
        return res.status(200).json({ items: [], error: 'No RSS feeds returned data' });
    }

    // ── Rank news headlines with Groq (X posts bypass AI ranking) ──────────
    let rankedItems = [];

    if (allHeadlines.length) {
        const headlineList = allHeadlines
            .map((h, i) => `${i}|${h.type}|${h.source}|${h.title.slice(0, 120)}`)
            .join('\n');

        const prompt = `You are a financial news editor for a serious crypto/DeFi portfolio tracker. From the headlines below, select only genuinely important stories. Return at most: 3 crypto, 3 defi, 2 macro. Return fewer if fewer qualify. Return [] if nothing qualifies. Never pad.

CRYPTO — include only: major exchange collapse/hack, significant regulatory decision (ETF approval/rejection, ban, new law passed), major stablecoin depeg, institutional/whale move >$500M. NEVER: BTC/ETH price moves, minor news, opinions.

DEFI — include only: major protocol hack or exploit, significant protocol upgrade or v2/v3 launch for a top-50 DeFi project, major tokenomics overhaul, new product launch by Uniswap/Aave/Curve/Compound/MakerDAO/Lido/Pendle/dYdX/GMX/Hyperliquid/EigenLayer, governance vote changing fundamental parameters. NEVER: minor integrations, TVL updates, farming guides, price predictions, opinions.

MACRO — include only: Fed rate decision or emergency statement, Bank of Japan rate decision, US/Japan military escalation or war declaration, major US sanctions, US sovereign debt crisis, crash/surge >5% in NVDA/ARKK/QQQ. NEVER: ECB/BOE decisions, non-US/Japan geopolitics, PPI, earnings, index moves, analyst opinions.

Headlines (index|type|source|title):
${headlineList}

Reply with ONLY a raw JSON array — no markdown, no explanation:
[{"index":0,"type":"defi","source":"Blockworks","title":"..."}]`;

        try {
            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_KEY}`,
                },
                signal: AbortSignal.timeout(15000),
                body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    temperature: 0.1,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });

            if (!groqRes.ok) {
                const err = await groqRes.json().catch(() => ({}));
                throw new Error(err?.error?.message || `Groq HTTP ${groqRes.status}`);
            }

            const groqData = await groqRes.json();
            const raw   = groqData.choices?.[0]?.message?.content || '';
            const clean = raw.replace(/```json|```/g, '').trim();
            const start = clean.indexOf('[');
            const end   = clean.lastIndexOf(']');
            if (start === -1) throw new Error('Groq returned no JSON array');

            const ranked = JSON.parse(clean.slice(start, end + 1));
            rankedItems = ranked.map(item => ({
                type:   item.type,
                source: item.source,
                title:  item.title || allHeadlines[item.index]?.title || '',
                url:    allHeadlines[item.index]?.link || '#',
            }));

        } catch (err) {
            // Groq failed — fall back to top raw headlines
            rankedItems = allHeadlines.slice(0, 8).map(h => ({
                type: h.type, source: h.source, title: h.title, url: h.link,
            }));
        }
    }

    // X posts come first, then ranked news
    const xItems = xPosts.map(p => ({
        type: 'x', source: p.source, title: p.title, url: p.link,
    }));

    return res.status(200).json({ items: [...xItems, ...rankedItems] });
}
