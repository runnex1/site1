// Vercel serverless function: fetch RSS headlines + rank with Groq AI
// GET /api/news  — returns pre-ranked news JSON, cached 2h on CDN edge
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=7200, stale-while-revalidate=3600');

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

    // ── Fetch + parse one RSS feed ──────────────────────────────────────────
    async function fetchFeed(src) {
        const r = await fetch(src.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();

        // Parse XML manually (no DOM in Node)
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

    // ── Fetch all feeds in parallel ─────────────────────────────────────────
    const settled = await Promise.allSettled(SOURCES.map(fetchFeed));
    const allHeadlines = settled.flatMap(s => s.status === 'fulfilled' ? s.value : []);

    if (!allHeadlines.length) {
        return res.status(200).json({ items: [], error: 'No RSS feeds returned data' });
    }

    // ── Rank with Groq ──────────────────────────────────────────────────────
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

        // Attach the original URLs from the headline list
        const items = ranked.map(item => ({
            type:   item.type,
            source: item.source,
            title:  item.title || allHeadlines[item.index]?.title || '',
            url:    allHeadlines[item.index]?.link || '#',
        }));

        return res.status(200).json({ items });

    } catch (err) {
        // Groq failed — fall back to returning top raw headlines (no AI ranking)
        const fallback = allHeadlines.slice(0, 8).map(h => ({
            type: h.type, source: h.source, title: h.title, url: h.link,
        }));
        return res.status(200).json({ items: fallback, groqError: err.message });
    }
}
