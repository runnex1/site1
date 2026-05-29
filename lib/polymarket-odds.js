const MONTH_SLUG = {
  jan: 'january', january: 'january', feb: 'february', february: 'february',
  mar: 'march', march: 'march', apr: 'april', april: 'april', may: 'may',
  jun: 'june', june: 'june', jul: 'july', july: 'july', aug: 'august', august: 'august',
  sep: 'september', sept: 'september', september: 'september', oct: 'october', october: 'october',
  nov: 'november', november: 'november', dec: 'december', december: 'december'
};
const MONTH_ANY = Object.keys(MONTH_SLUG).sort((a, b) => b.length - a.length).join('|');
const GENERIC = new Set([
  'what','are','is','the','of','on','by','to','for','a','an','in','and','or','if','will','would','could','being','be',
  'polymarket','odds','probability','chance','chances','market','yes','no','price','trading','outcome','outcomes',
  'out','president','before','after','during','removed','leave','leaves','office','by','win','wins','perform','happen','happens',
  'january','february','march','april','may','june','july','august','september','october','november','december'
]);

function isPolymarketOddsQuestion(q) {
  return /\bpolymarket\b/i.test(q) && /\b(odds|probability|chance|chances|price|market|yes|no)\b/i.test(q);
}
function cleanText(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function dateTokens(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  for (const [name, full] of Object.entries(MONTH_SLUG)) if (new RegExp('\\b' + name + '\\b').test(s)) tokens.push(full.slice(0, 3));
  for (const d of [...s.matchAll(/\b([1-3]?\d)(?:st|nd|rd|th)?\b/g)]) tokens.push(String(Number(d[1])));
  return [...new Set(tokens)];
}
function explicitSubjectTerms(question) {
  const original = String(question || '');
  const proper = [...original.matchAll(/\b[A-Z][A-Za-z0-9]{2,}\b/g)]
    .map(m => m[0].toLowerCase())
    .filter(w => !GENERIC.has(w) && !MONTH_SLUG[w]);
  if (proper.length) return [...new Set(proper)].slice(0, 4);
  const dates = new Set(dateTokens(original));
  return original.toLowerCase().replace(/[?!.,:/#]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !GENERIC.has(w) && !MONTH_SLUG[w] && !dates.has(w) && !/^\d+$/.test(w))
    .slice(0, 4);
}
function marketText(m) { return String(m?.question || m?.title || m?.slug || '').toLowerCase(); }
function hasAllTerms(hay, terms) { return terms.every(t => hay.includes(String(t).toLowerCase())); }
function marketMatchesDate(question, text) {
  const wanted = dateTokens(question);
  if (!wanted.length) return true;
  const hay = String(text || '').toLowerCase();
  return wanted.every(t => hay.includes(t));
}
function decodeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function outcomesFor(market) {
  const outcomes = decodeArray(market.outcomes || market.outcomeNames);
  const prices = decodeArray(market.outcomePrices).map(Number);
  return outcomes.map((name, i) => ({ name: String(name || '').trim(), price: Number.isFinite(prices[i]) ? prices[i] : null }));
}
function formatOdds(price) {
  if (price == null || !Number.isFinite(Number(price))) return '?';
  const pct = Number(price) * 100;
  if (pct > 0 && pct < 1) return pct.toFixed(2) + '%';
  return pct.toFixed(1) + '%';
}
async function safeJson(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
function normalizeMarkets(data) {
  if (!data) return [];
  const roots = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : Array.isArray(data.events) ? data.events : [data];
  const markets = [];
  for (const root of roots) {
    if (!root) continue;
    if (Array.isArray(root.markets)) markets.push(...root.markets);
    else if (root.outcomePrices && (root.question || root.title)) markets.push(root);
  }
  return markets.filter(m => m && (m.question || m.title) && m.outcomePrices);
}
function pickOutcome(market, desired = 'Yes') {
  const outcomes = outcomesFor(market);
  const want = String(desired || 'Yes').toLowerCase();
  return outcomes.find(o => o.name.toLowerCase() === want) || outcomes.find(o => o.name.toLowerCase().includes(want)) || outcomes.find(o => o.name.toLowerCase() === 'yes') || outcomes[0] || { name: desired || 'Yes', price: null };
}
function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function extractUrlSlug(question) {
  const m = String(question || '').match(/polymarket\.com\/event\/([^\s?#]+)/i);
  return m ? m[1].replace(/#.*$/, '') : null;
}
async function groqJson(prompt, fallback) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return fallback;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(9000),
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', temperature: 0, max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) return fallback;
    const raw = ((await r.json()).choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : raw);
  } catch { return fallback; }
}
async function parseQuestion(question) {
  const subjects = explicitSubjectTerms(question);
  const dates = dateTokens(question);
  const fallbackSearch = [...subjects, ...dates].join(' ') || question.replace(/\b(polymarket|odds|chance|chances|probability|what|are|the|of|on)\b/gi, ' ').trim();
  const fallback = { searchQueries: [fallbackSearch, subjects.join(' ')].filter(Boolean), requiredTerms: subjects, dateTerms: dates, outcome: 'Yes', slugCandidates: [] };
  const parsed = await groqJson(
    'Parse this Polymarket odds question. Return JSON only: {"searchQueries":[short queries],"requiredTerms":[key subject/topic terms that MUST appear in the market title],"dateTerms":[month/day terms if any],"outcome":"Yes/No/exact outcome","slugCandidates":[possible polymarket event slugs]}. Do not include generic words like odds, market, polymarket, yes, no. Question: ' + question,
    fallback
  );
  parsed.searchQueries = Array.isArray(parsed.searchQueries) ? parsed.searchQueries : fallback.searchQueries;
  parsed.requiredTerms = Array.isArray(parsed.requiredTerms) && parsed.requiredTerms.length ? parsed.requiredTerms.map(x => String(x).toLowerCase()) : fallback.requiredTerms;
  parsed.dateTerms = Array.isArray(parsed.dateTerms) ? parsed.dateTerms.map(x => String(x).toLowerCase().slice(0,3)).concat(fallback.dateTerms) : fallback.dateTerms;
  parsed.outcome = parsed.outcome || 'Yes';
  parsed.slugCandidates = Array.isArray(parsed.slugCandidates) ? parsed.slugCandidates : [];

  const urlSlug = extractUrlSlug(question);
  if (urlSlug) parsed.slugCandidates.unshift(urlSlug);

  const q = String(question || '').toLowerCase();
  const outBy = q.match(/([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*){0,4})\s+out(?:\s+as\s+president(?:\s+of\s+([a-z]+))?)?\s+by\s+([a-z]+)\s+([1-3]?\d)/i);
  if (outBy) {
    const subject = slugify(outBy[1].replace(/\b(what|are|odds|the|of)\b/gi, ''));
    const country = outBy[2] ? '-of-' + slugify(outBy[2]) : '';
    const month = MONTH_SLUG[outBy[3].toLowerCase()] || outBy[3].toLowerCase();
    const day = String(Number(outBy[4]));
    if (subject) {
      parsed.slugCandidates.unshift(`${subject}-out-as-president${country}-by-${month}-${day}`);
      parsed.slugCandidates.unshift(`${subject}-out-by-${month}-${day}`);
    }
  }
  parsed.slugCandidates = [...new Set(parsed.slugCandidates.filter(Boolean))];
  return parsed;
}
async function fetchExactSlug(slug) {
  const pageUrl = 'https://polymarket.com/event/' + slug;
  const urls = [
    `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`,
    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
    `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`
  ];
  for (const url of urls) {
    const data = await safeJson(url, { timeout: 10000 });
    const markets = normalizeMarkets(data);
    if (markets.length) return { market: markets.sort((a, b) => Number(b.volume || b.volumeNum || 0) - Number(a.volume || a.volumeNum || 0))[0], url: pageUrl };
  }
  try {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)', Accept: 'text/html' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const html = await res.text();
    const title = cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]).replace(/\s*Trading Odds.*$/i, '') || slug.replace(/-/g, ' ');
    const chance = html.match(/([<>]?\d+(?:\.\d+)?)%\s*chance/i)?.[1];
    if (chance) return { pageOnly: true, title, oddsText: chance + '%', url: pageUrl };
  } catch {}
  return null;
}
async function searchMarkets(queries) {
  const byKey = new Map();
  for (const query of [...new Set((queries || []).filter(Boolean))]) {
    const urls = [
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&search=' + encodeURIComponent(query),
      'https://gamma-api.polymarket.com/markets?limit=50&search=' + encodeURIComponent(query)
    ];
    for (const url of urls) {
      const data = await safeJson(url);
      const markets = Array.isArray(data) ? data : data?.markets || data?.data || [];
      for (const m of markets) if (m && (m.question || m.title) && m.outcomePrices) byKey.set(m.id || m.slug || m.question, m);
    }
  }
  return [...byKey.values()];
}
async function aiValidate(question, markets) {
  if (!markets.length) return { index: -1, outcome: 'Yes' };
  const list = markets.slice(0, 12).map((m, i) => `${i}: ${m.question || m.title || m.slug}`).join('\n');
  return await groqJson('Pick the one market that exactly answers the user question. Return {"index":number,"outcome":"Yes/No/exact outcome"}. Return {"index":-1,"outcome":"Yes"} if none match the subject/topic/date exactly.\nQuestion: ' + question + '\nMarkets:\n' + list, { index: -1, outcome: 'Yes' });
}
function marketPassesHardFilters(question, parsed, market) {
  const text = String(market.question || market.title || market.slug || '').toLowerCase();
  const req = (parsed.requiredTerms || []).map(x => String(x).toLowerCase()).filter(x => x.length > 2 && !GENERIC.has(x) && !MONTH_SLUG[x]);
  if (req.length && !hasAllTerms(text, req)) return false;
  const dates = dateTokens(question);
  if (dates.length && !dates.every(d => text.includes(d))) return false;
  return true;
}
function buildAnswer(market, desired, urlOverride) {
  const title = market.question || market.title || market.slug || 'Selected market';
  const selected = pickOutcome(market, desired);
  const slug = market.slug || market.market_slug || '';
  const url = urlOverride || (slug ? 'https://polymarket.com/event/' + slug : 'https://polymarket.com');
  return { ok: true, kind: 'polymarket', answer: `${selected.name || 'Outcome'} is trading at ${formatOdds(selected.price)} on Polymarket for: ${title}`, sources: [{ domain: 'polymarket', title: title.slice(0, 90), url }], headlines: [] };
}
async function answerPolymarketOddsQuestion(question) {
  const parsed = await parseQuestion(question);
  for (const slug of parsed.slugCandidates || []) {
    const exact = await fetchExactSlug(slug);
    if (exact?.market) return buildAnswer(exact.market, parsed.outcome, exact.url);
    if (exact?.pageOnly) return { ok: true, kind: 'polymarket', answer: `Yes is trading at ${exact.oddsText} on Polymarket for: ${exact.title}`, sources: [{ domain: 'polymarket', title: exact.title.slice(0, 90), url: exact.url }], headlines: [] };
  }
  const markets = (await searchMarkets(parsed.searchQueries)).filter(m => marketPassesHardFilters(question, parsed, m));
  if (!markets.length) return { ok: false, kind: 'polymarket', answer: 'I could not find a Polymarket market that matches the subject/topic/date in your question.', sources: [], headlines: [] };
  const picked = await aiValidate(question, markets);
  if (Number(picked.index) < 0 || Number(picked.index) >= Math.min(markets.length, 12)) return { ok: false, kind: 'polymarket', answer: 'I found Polymarket results, but none clearly matched your question.', sources: [], headlines: [] };
  return buildAnswer(markets[Number(picked.index)], picked.outcome || parsed.outcome);
}
module.exports = { isPolymarketOddsQuestion, answerPolymarketOddsQuestion };
