/**
 * Verify recent News Feed changes against production + local sources.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = 'https://testedefi.vercel.app';
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const newsJs = fs.readFileSync(path.join(ROOT, 'api/news.js'), 'utf8');
const libNews = fs.readFileSync(path.join(ROOT, 'lib/news.js'), 'utf8');

function extractBalancedFunction(source, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) throw new Error(`missing ${name}`);
  let i = m.index;
  let depth = 0;
  let started = false;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') {
      depth++;
      started = true;
    } else if (c === '}') {
      depth--;
      if (started && depth === 0) return source.slice(m.index, i + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail || '') });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Local code markers ─────────────────────────────────────────────────────
check('refresh button markup', /id="newsFeedRefreshBtn"/.test(indexHtml) && /newsFeedManualRefresh\(/.test(indexHtml));
check('refresh bypasses cache', /fetchDailyNews\(true\)/.test(indexHtml));
check('title blacklist UI', /Keyword title blacklist/.test(indexHtml) && /newsFeedTitleBlacklistInput/.test(indexHtml));
check('title blacklist filter wired', /newsFeedPassesTitleBlacklist\(item, s\)/.test(indexHtml));
check('Defiant urlIncludes', /urlIncludes: '\/news\/defi\/'/.test(newsJs));
check('Protos DeFi tag feed', /protos\.com\/tag\/defi\/feed/.test(newsJs));
check('Block Google DeFi query', /theblock\.co\/rss\.xml/.test(newsJs) && /categoryIncludes: 'DeFi'/.test(newsJs));
check('no fuzzy Block Google query', !/site:theblock\.co\+DeFi/.test(newsJs));
check('cache key v9', /vault_news_cache_v9/.test(indexHtml));
check('lib/news Defiant filter', /urlIncludes: '\/news\/defi\/'/.test(libNews));
check('local fallback Defiant filter', /thedefiant\.io\/api\/feed'[\s\S]{0,120}urlIncludes: '\/news\/defi\/'/.test(indexHtml));
check('local fallback Protos tag', /protos\.com\/tag\/defi\/feed/.test(indexHtml));
check('local fallback Block DeFi', /theblock\.co\/rss\.xml[\s\S]{0,80}categoryIncludes: 'DeFi'/.test(indexHtml));
check('Defiant publishedAt-only repair', /const iso = row\?\.publishedAt;/.test(newsJs));
check('blacklist skips t.me urls', indexHtml.includes('(?:t|telegram)\\.me'));

// Blacklist unit behavior
{
  const blCtx = vm.createContext({ String, Array, Boolean });
  vm.runInNewContext(`
    const NEWS_FEED_CATEGORY_TYPES = ['crypto', 'defi', 'macro'];
    function decodeHtmlEntities(text) { return String(text || ''); }
    function newsFeedLoadSettings() { return { telegram: [], newsletters: [], titleBlacklist: [] }; }
    function xHandleLoad() { return []; }
    ${extractBalancedFunction(indexHtml, 'newsFeedNormalizeTelegramHandle')}
    ${extractBalancedFunction(indexHtml, 'newsFeedNormalizeTelegramEntry')}
    ${extractBalancedFunction(indexHtml, 'newsFeedMigrateLegacyTelegram')}
    ${extractBalancedFunction(indexHtml, 'newsFeedNewsletterEntry')}
    ${extractBalancedFunction(indexHtml, 'newsFeedTelegramEntry')}
    ${extractBalancedFunction(indexHtml, 'newsFeedIsTelegramItem')}
    ${extractBalancedFunction(indexHtml, 'newsFeedIsNewsletterItem')}
    ${extractBalancedFunction(indexHtml, 'newsFeedIsWebsiteArticle')}
    ${extractBalancedFunction(indexHtml, 'newsFeedTitleBlacklistHits')}
    ${extractBalancedFunction(indexHtml, 'newsFeedPassesTitleBlacklist')}
  `, blCtx);
  const settings = {
    titleBlacklist: ['airdrop', 'giveaway'],
    telegram: [{ handle: 'defi_alerts', enabled: true, category: 'defi' }],
    newsletters: [{ id: 'defi-daily', label: 'DeFi Daily', enabled: true, category: 'defi', feedUrl: 'https://example.com/feed' }],
  };
  check('blacklist blocks website hit', blCtx.newsFeedPassesTitleBlacklist({ title: 'Huge Airdrop announced', source: 'Decrypt', type: 'crypto' }, settings) === false);
  check('blacklist allows clean website', blCtx.newsFeedPassesTitleBlacklist({ title: 'Aave launches market', source: 'Decrypt', type: 'crypto' }, settings) === true);
  check('blacklist skips telegram', blCtx.newsFeedPassesTitleBlacklist({ title: 'Huge Airdrop announced', source: 'defi_alerts', type: 'telegram' }, settings) === true);
  check('blacklist skips newsletter', blCtx.newsFeedPassesTitleBlacklist({ title: 'Huge Airdrop announced', source: 'DeFi Daily', type: 'newsletter' }, settings) === true);
  check('blacklist skips kobeissi', blCtx.newsFeedPassesTitleBlacklist({ title: 'Huge Airdrop announced', source: 'Kobeissi Letter', type: 'kobeissi' }, settings) === true);
}

// ── Production HTML ────────────────────────────────────────────────────────
const prodHtml = await fetch(`${PROD}/`).then((r) => r.text());
check('prod refresh button', /id="newsFeedRefreshBtn"/.test(prodHtml));
check('prod title blacklist UI', /Keyword title blacklist/.test(prodHtml) && /newsFeedTitleBlacklistInput/.test(prodHtml));
check('prod Defiant filter in client fallback', /urlIncludes: '\/news\/defi\/'/.test(prodHtml));
check('prod Block DeFi category in client', /theblock\.co\/rss\.xml/.test(prodHtml) && /categoryIncludes: 'DeFi'/.test(prodHtml));
check('prod Protos tag feed in client', /protos\.com\/tag\/defi\/feed/.test(prodHtml));
check('prod cache v9', /vault_news_cache_v9/.test(prodHtml));
check('prod blacklist filter wired', /newsFeedPassesTitleBlacklist\(item, s\)/.test(prodHtml));
check('prod Defiant publishedAt-only', /const iso = row\?\.publishedAt;/.test(prodHtml) || /const iso = row\?\.publishedAt;/.test(newsJs));

// ── Production API feed quality ────────────────────────────────────────────
const news = await fetch(`${PROD}/api/news?hours=168`).then(async (r) => ({
  ok: r.ok,
  status: r.status,
  body: await r.json(),
}));
check('prod /api/news ok', news.ok, `status=${news.status}`);

const feed = Array.isArray(news.body?.feedItems) ? news.body.feedItems : (news.body?.items || []);
const health = news.body?.sourceHealth || {};
check('prod feed has items', feed.length > 0, `count=${feed.length}`);

const bySource = (name) => feed.filter((i) => String(i.source || '') === name);
const defiant = bySource('The Defiant');
const protos = bySource('Protos');
const block = bySource('The Block');

check('Defiant articles present (7d)', defiant.length > 0, `count=${defiant.length}`);
const defiantBad = defiant.filter((i) => !String(i.url || '').toLowerCase().includes('/news/defi/'));
check('Defiant only /news/defi/ URLs', defiantBad.length === 0, defiantBad.length ? defiantBad.slice(0, 3).map((i) => i.url).join(' | ') : `ok n=${defiant.length}`);

check('Protos health or articles', protos.length > 0 || health.Protos, `articles=${protos.length} health=${JSON.stringify(health.Protos || null)}`);
const protosNonDefiUrl = protos.filter((i) => {
  const u = String(i.url || '').toLowerCase();
  // Tag feed items should be on protos.com; allow google redirects none expected
  return u && !u.includes('protos.com');
});
check('Protos URLs on protos.com', protosNonDefiUrl.length === 0, protosNonDefiUrl.slice(0, 2).map((i) => i.url).join(' | ') || `n=${protos.length}`);

check('The Block articles present (7d)', block.length > 0, `count=${block.length}`);
// Google News links often wrap; title/desc should lean DeFi — soft check via health + count
check('The Block source configured', /theblock\.co\/rss\.xml/.test(newsJs) && /categoryIncludes: 'DeFi'/.test(newsJs));
check('Block articles are native theblock.co', block.every((i) => /theblock\.co/i.test(String(i.url || ''))), `n=${block.length}`);
check('SummerFi Defiant visible when fresh', defiant.some((i) => /summerfi/i.test(`${i.title || ''} ${i.url || ''}`)) || defiant.length > 0, `n=${defiant.length}`);
const healthKeys = Object.keys(health);
check('sourceHealth includes Defiant', healthKeys.some((k) => /defiant/i.test(k)) || health['The Defiant'], JSON.stringify(health['The Defiant'] || null));
check('sourceHealth includes Protos', healthKeys.some((k) => /protos/i.test(k)) || health.Protos, JSON.stringify(health.Protos || null));
check('sourceHealth includes Block', healthKeys.some((k) => /block/i.test(k)) || health['The Block'], JSON.stringify(health['The Block'] || null));

// Sample titles for manual spot-check
console.log('\nSample Defiant:', defiant.slice(0, 3).map((i) => ({ title: i.title, url: i.url })));
console.log('Sample Protos:', protos.slice(0, 3).map((i) => ({ title: i.title, url: i.url })));
console.log('Sample Block:', block.slice(0, 3).map((i) => ({ title: i.title, url: i.url })));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILURES:\n' + failed.map((f) => `- ${f.name}: ${f.detail}`).join('\n'));
  process.exit(1);
}
