/**
 * lib/news-sources.js
 * Canonical RSS source list shared by api/ask.js and api/event-check.js.
 *
 * getNewsSources(query, shortQuery?)
 *   query      — full search string (encoded by caller)
 *   shortQuery — optional shorter variant for a second Google News search
 *
 * Returns an array of URLs to fetch in parallel.
 */
function getNewsSources(query, shortQuery) {
  const q = encodeURIComponent(query);
  const urls = [
    // Google News — full query (most reliable for breaking news)
    `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
    // AP News
    'https://rsshub.app/apnews/topics/apf-topnews',
    // BBC
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://feeds.bbci.co.uk/news/business/rss.xml',
    // NYT World
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    // Al Jazeera
    'https://www.aljazeera.com/xml/rss/all.xml',
    // CNBC
    'https://www.cnbc.com/id/10000664/device/rss/rss.html',
    // Kobeissi Letter (Telegram) — macro & markets analysis
    'https://rsshub.app/telegram/channel/thekobeissiletter',
  ];

  // Optional second Google News search with a shorter/entity-focused query
  if (shortQuery && shortQuery !== query) {
    const sq = encodeURIComponent(shortQuery);
    urls.splice(1, 0, `https://news.google.com/rss/search?q=${sq}&hl=en-US&gl=US&ceid=US:en`);
  }

  return urls;
}

module.exports = { getNewsSources };
