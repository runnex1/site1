const MONTHS = {
  jan:'january', january:'january', feb:'february', february:'february', mar:'march', march:'march',
  apr:'april', april:'april', may:'may', jun:'june', june:'june', jul:'july', july:'july',
  aug:'august', august:'august', sep:'september', sept:'september', september:'september',
  oct:'october', october:'october', nov:'november', november:'november', dec:'december', december:'december'
};
const MONTH_RE = Object.keys(MONTHS).sort((a,b)=>b.length-a.length).join('|');
const FILLER = new Set('what are is the of on by to for a an in and or if will would could being be polymarket odds probability chance chances market markets yes no price trading outcome outcomes'.split(' '));
const GENERIC = new Set('new latest next first last any all this that these those its their his her files file docs documents document report reports before after during by end'.split(' '));
const SOFT = new Set('out president prime minister before after during removed leave leaves office win wins lose loses happen happens perform by end'.split(' '));
const PREFIXES = new Set(['will','can','does','do','did','is','are','was','were','has','have']);
const VERB_FAMILIES = [
  ['win','wins','winning','won','become','becomes','becoming','became','elect','elected','election'],
  ['buy','buys','buying','bought','acquire','acquires','acquiring','acquired'],
  ['launch','launches','launching','launched'],
  ['perform','performs','performing','performed'],
  ['hit','hits','hitting','reach','reaches','reaching','reached'],
  ['declassify','declassifies','declassifying','declassified'],
  ['move','moves','moving','moved'],
  ['enter','enters','entering','entered'],
  ['leave','leaves','leaving','left','out','removed','resign','resigns','resigning','resigned']
];

function isPolymarketOddsQuestion(q){ return /\bpolymarket\b/i.test(q) && /\b(odds|probability|chance|chances|price|market|yes|no)\b/i.test(q); }
function normalize(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function slugify(s){ return normalize(s).replace(/\s+/g,'-'); }
function cleanText(s){ return String(s||'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/\s+/g,' ').trim(); }
function datePart(q){ const m=String(q||'').toLowerCase().match(new RegExp('\\b('+MONTH_RE+')\\b\\s*([1-3]?\\d)(?:st|nd|rd|th)?')); return m ? {month:MONTHS[m[1]]||m[1], short:(MONTHS[m[1]]||m[1]).slice(0,3), day:String(Number(m[2]))} : null; }
function yearTerms(q){ return [...new Set((String(q||'').match(/\b20\d{2}\b/g)||[]))]; }
function anchorText(q){ return String(q||'').split(/\b(?:alert\s+me\s+when|alert|odds|chance|chances|probability|price)\b/i).slice(1).join(' ') || String(q||''); }
function requiredCapitalTerms(q){ const out=[]; for(const m of anchorText(q).matchAll(/\b([A-Z][A-Za-z0-9]{1,})\b/g)){ const term=normalize(m[1]); if(!term || PREFIXES.has(term) || FILLER.has(term)){ if(out.length) break; continue; } out.push(term); if(out.length>=3) break; } return out; }
function requiredCapitalTerm(q){ return requiredCapitalTerms(q)[0] || null; }
function marketTitle(m){ const base=String(m?.question||m?.title||m?.name||m?.slug||m?.market_slug||'').trim(); const group=String(m?.groupItemTitle||m?.groupItem||m?.groupTitle||'').trim(); if(!group || normalize(base).includes(normalize(group))) return base || group; if(/\bby\s*$/i.test(base)) return `${base} ${group}?`; return `${base} ${group}`.trim(); }
function marketText(m){ return normalize(marketTitle(m)); }
function decodeArray(v){ if(Array.isArray(v)) return v; if(typeof v!=='string') return []; try{ const p=JSON.parse(v); return Array.isArray(p)?p:[]; }catch{return [];} }
function outcomes(m){ const names=decodeArray(m.outcomes||m.outcomeNames), prices=decodeArray(m.outcomePrices).map(Number); return names.map((name,i)=>({name:String(name||'').trim(), price:Number.isFinite(prices[i])?prices[i]:null})); }
function pickOutcome(m,want='Yes'){ const outs=outcomes(m), w=String(want||'Yes').toLowerCase(); return outs.find(o=>o.name.toLowerCase()===w) || outs.find(o=>o.name.toLowerCase().includes(w)) || outs.find(o=>o.name.toLowerCase()==='yes') || outs[0] || {name:want,price:null}; }
function displayOutcome(m,want='Yes'){
  const outs=outcomes(m), requested=String(want||'Yes').toLowerCase();
  if(requested && requested !== 'yes') return pickOutcome(m,want);
  const yes=outs.find(o=>o.name.toLowerCase()==='yes');
  if(yes && Number.isFinite(yes.price) && yes.price < 0.5){
    return outs.find(o=>o.name.toLowerCase()==='no') || {name:'No',price:1-yes.price};
  }
  return yes || pickOutcome(m,want);
}
function formatOdds(price){ if(price==null || !Number.isFinite(Number(price))) return '?'; const pct=Number(price)*100; if(pct===0) return '<0.1%'; if(pct>0&&pct<1) return pct.toFixed(2)+'%'; return pct.toFixed(1)+'%'; }
function pageOnlyDisplay(ex){
  const raw=String(ex.oddsText||'').trim(), n=Number(raw.replace(/[<%]/g,''));
  if(Number.isFinite(n) && n < 50 && !raw.includes('<')) return {name:'No',oddsText:formatOdds((100-n)/100)};
  if(Number.isFinite(n) && raw.includes('<')) return {name:'No',oddsText:'>99.9%'};
  return {name:'Yes',oddsText:raw || '?'};
}
function marketVolume(m){ return Number(m?.volumeNum ?? m?.volume ?? m?.liquidityNum ?? m?.liquidity ?? 0)||0; }
function parseDateMs(v){ const t=Date.parse(String(v||'')); return Number.isFinite(t) ? t : null; }
function marketEnded(m){
  const e=m?.event||{};
  if(m?.closed===true || m?.resolved===true || m?.archived===true || e.closed===true || e.resolved===true || e.archived===true) return true;
  if(m?.active===false || e.active===false) return true;
  const status=normalize([m?.status,m?.resolutionStatus,m?.state,e.status,e.resolutionStatus,e.state].filter(Boolean).join(' '));
  if(/\b(closed|resolved|ended|settled|archived)\b/.test(status)) return true;
  const dates=[m?.endDate,m?.endDateIso,m?.end_date,m?.closedTime,m?.closeTime,e.endDate,e.endDateIso,e.end_date,e.closedTime,e.closeTime].map(parseDateMs).filter(Boolean);
  return dates.some(t=>t < Date.now() - 6*60*60*1000);
}
function numberTargets(q){
  const out=[];
  const re=/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s*[kKmM]\b/g;
  for(const raw of String(q||'').match(re)||[]){
    const compact=raw.toLowerCase().replace(/\s+/g,'').replace(/,/g,'');
    let value=null;
    if(compact.endsWith('k')) value=Number(compact.slice(0,-1))*1000;
    else if(compact.endsWith('m')) value=Number(compact.slice(0,-1))*1000000;
    else value=Number(compact);
    if(Number.isFinite(value)) out.push(String(Math.round(value)));
  }
  return [...new Set(out)];
}
function numberTargetMatches(title,target){
  const compact=String(title||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
  const n=Number(target);
  const variants=[String(target)];
  if(Number.isFinite(n) && n%1000===0) variants.push(String(n/1000)+'k');
  if(Number.isFinite(n) && n%1000000===0) variants.push(String(n/1000000)+'m');
  return variants.some(v=>compact.includes(v));
}
function keyTerms(q){ const d=datePart(q), out=[]; for(const w of normalize(q).split(/\s+/)){ if(!w || FILLER.has(w)) continue; if(MONTHS[w]){ out.push(MONTHS[w].slice(0,3)); continue; } if(/^\d+$/.test(w)){ if(/^20\d{2}$/.test(w) || (d && w===d.day)) out.push(w); continue; } out.push(w); } return [...new Set(out)]; }
function subjectTerms(q){ return keyTerms(q).filter(w=>!/^\d+$/.test(w) && !SOFT.has(w) && !GENERIC.has(w) && !MONTHS[w]).slice(0,8); }
function clusterTerms(q){ return keyTerms(q).filter(w=>w.length>2 && !/^\d+$/.test(w) && !GENERIC.has(w) && !MONTHS[w]).slice(0,10); }
function titleClusterTerms(m){
  return normalize(marketTitle(m)).split(/\s+/).filter(w=>w.length>2 && !/^\d+$/.test(w) && !FILLER.has(w) && !GENERIC.has(w) && !MONTHS[w] && !/^(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)$/.test(w));
}
function verbFamily(t){ return VERB_FAMILIES.find(f=>f.includes(String(t||'').toLowerCase())) || null; }
function canonicalTerm(t){ const fam=verbFamily(t); if(fam) return fam[0]; t=String(t||'').toLowerCase(); if(t.endsWith('ies')&&t.length>4) return t.slice(0,-3)+'y'; if(t.endsWith('ing')&&t.length>5){ const base=t.slice(0,-3); return /(.)\1$/.test(base) ? base.slice(0,-1) : base; } if(t.endsWith('ed')&&t.length>4) return t.slice(0,-2); if(t.endsWith('es')&&t.length>4) return t.slice(0,-2); if(t.endsWith('s')&&t.length>3) return t.slice(0,-1); return t; }
function termVariants(t){ t=String(t||'').toLowerCase(); const vars=new Set([t,canonicalTerm(t)]); const fam=verbFamily(t); if(fam) fam.forEach(v=>vars.add(v)); if(t.endsWith('ies')&&t.length>4) vars.add(t.slice(0,-3)+'y'); if(t.endsWith('es')&&t.length>4) vars.add(t.slice(0,-2)); if(t.endsWith('s')&&t.length>3) vars.add(t.slice(0,-1)); if(t.endsWith('ed')&&t.length>4) vars.add(t.slice(0,-2)); if(t.endsWith('ing')&&t.length>5){ const base=t.slice(0,-3); vars.add(base); if(/(.)\1$/.test(base)) vars.add(base.slice(0,-1)); } return [...vars].filter(Boolean); }
function termMatches(title, term){ return termVariants(term).some(t=>title.includes(t)); }
function requiredOk(q,title){ const caps=requiredCapitalTerms(q); if(caps.length && !caps.every(cap=>termMatches(title,cap))) return false; const nums=numberTargets(q); if(nums.length && !nums.some(n=>numberTargetMatches(title,n))) return false; const years=yearTerms(q); if(years.length && !years.every(y=>title.includes(y))) return false; const strong=subjectTerms(q).filter(w=>w.length>2 && !/^20\d{2}$/.test(w)); if(!strong.length) return true; return strong.filter(w=>termMatches(title,w)).length >= Math.min(2,strong.length); }
function dateOk(title,d){ return !d || (title.includes(d.short) && title.includes(d.day)); }
function score(q,m,slug=''){ const title=marketText(m), d=datePart(q), subs=subjectTerms(q); if(subs.length && !subs.some(s=>termMatches(title,s))) return -999; if(!requiredOk(q,title) || !dateOk(title,d)) return -999; let s=10; for(const t of keyTerms(q)) if(termMatches(title,t)) s += (SOFT.has(t)||GENERIC.has(t)) ? 1 : 3; for(const y of yearTerms(q)) if(title.includes(y)) s += 8; if(d) s+=8; const mslug=slugify(m.slug||m.market_slug||''), wanted=slugify(slug); if(wanted && (mslug===wanted || mslug.includes(wanted) || wanted.includes(mslug))) s+=50; return s; }

async function safeJson(url, timeout=3500){ try{ const r=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(timeout)}); return r.ok ? await r.json() : null; }catch{return null;} }
async function safeText(url, timeout=3000){ try{ const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; VaultBot/1.0)',Accept:'text/html'},signal:AbortSignal.timeout(timeout)}); return r.ok ? await r.text() : null; }catch{return null;} }
function pageLooksEnded(text){ const n=normalize(text); return /\b(past ended|resolved|final result|no longer open for trading|market has ended|market ended)\b/.test(n); }
function marketsFrom(data){ if(!data) return []; const roots=Array.isArray(data)?data:Array.isArray(data.data)?data.data:Array.isArray(data.events)?data.events:Array.isArray(data.results)?data.results:Array.isArray(data.items)?data.items:[data]; const out=[]; for(const r of roots){ if(!r) continue; if(Array.isArray(r.markets)) out.push(...r.markets.map(m=>({...m,event:m.event||r}))); else if(r.market) out.push({...r.market,event:r.event||r.market.event}); else if(r.event?.markets) out.push(...r.event.markets.map(m=>({...m,event:m.event||r.event}))); else if(r.outcomePrices && (r.question||r.title||r.name)) out.push(r); } return out.filter(m=>m && (m.question||m.title||m.name) && m.outcomePrices); }
function uniqueMarkets(markets){ const by=new Map(); for(const m of markets||[]){ const key=m?.id||m?.conditionId||m?.slug||m?.market_slug||marketTitle(m); if(key && !by.has(key)) by.set(key,m); } return [...by.values()]; }
function rankedMarkets(q,markets,slug=''){ return uniqueMarkets(markets).filter(m=>!marketEnded(m)).map(m=>({m,s:score(q,m,slug)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s || marketVolume(b.m)-marketVolume(a.m)); }
function filterTopCluster(q,markets){
  const unique=uniqueMarkets(markets);
  const terms=clusterTerms(q);
  if(unique.length<=1) return unique;
  let kept=unique;
  const outPhrase=requiredOutPhrase(q);
  if(outPhrase){
    const phraseKept=kept.filter(m=>marketText(m).includes(outPhrase));
    if(phraseKept.length) kept=phraseKept;
  }
  if(terms.length>=3){
    const scored=kept.map(m=>({m,hits:terms.filter(t=>termMatches(marketText(m),t)).length}));
    const max=Math.max(...scored.map(x=>x.hits));
    if(max>=3) kept=scored.filter(x=>x.hits===max).map(x=>x.m);
  }
  if(kept.length<=2) return kept;
  const freq=new Map();
  for(const m of kept) for(const t of new Set(titleClusterTerms(m))) freq.set(t,(freq.get(t)||0)+1);
  const common=[...freq.entries()].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([t])=>t);
  if(common.length<3) return kept;
  const commonScored=kept.map(m=>({m,hits:common.filter(t=>termMatches(marketText(m),t)).length}));
  const maxCommon=Math.max(...commonScored.map(x=>x.hits));
  if(maxCommon<3) return kept;
  const commonKept=commonScored.filter(x=>x.hits===maxCommon).map(x=>x.m);
  return commonKept.length ? commonKept : kept;
}
function parseUrl(q){ const m=String(q||'').match(/polymarket\.com\/event\/([^\s?#]+)(?:\/([^\s?#]+))?/i); return m ? {parent:m[1].replace(/#.*$/,''), child:m[2]?.replace(/#.*$/,'')||null} : null; }
function questionMarketPhrase(q){ let s=String(q||'').replace(/https?:\/\/\S+/gi,' ').trim(); s=s.replace(/^\s*(what\s+(?:are\s+the\s+odds|is\s+the\s+(?:probability|chance))|what'?s\s+the\s+(?:probability|chance)|odds|probability|chance|price)\s+(?:that\s+)?/i,''); return s.replace(/\s+(?:on\s+)?polymarket\??\s*$/i,'').replace(/\?+$/,'').trim(); }
function requiredOutPhrase(q){ const m=normalize(questionMarketPhrase(q)).match(/^(.+?)\s+out\b/); return m ? `${m[1]} out` : null; }
function slugTypoVariants(slug){ const out=[slug]; if(String(slug).includes('airdrop')) out.push(String(slug).replace(/airdrop/g,'airdop')); return out; }
function expandSlugVariants(slugs){ const out=[]; for(const slug of slugs||[]) out.push(...slugTypoVariants(slug)); return [...new Set(out.filter(Boolean))]; }
function phraseSlugVariants(phrase){ const base=slugify(phrase), out=[]; if(!base) return out; out.push(base); const first=base.split('-')[0]; if(!PREFIXES.has(first)) out.push('will-'+base); if(/^will-/.test(base)) out.push(base.replace(/^will-/,'')); return expandSlugVariants(out); }
function priceLadderSlugs(q){
  const s=String(q||'').toLowerCase(), out=[];
  const asset=(s.match(/\b(bitcoin|ethereum|solana|xrp|dogecoin|btc|eth|sol|doge)\b/)||[])[1];
  const month=(s.match(new RegExp('\\b('+MONTH_RE+')\\b'))||[])[1];
  if(!asset || !month || !/\b(hits?|reaches|reach|price)\b/.test(s)) return out;
  const name={btc:'bitcoin',eth:'ethereum',sol:'solana',doge:'dogecoin'}[asset]||asset;
  const m=MONTHS[month]||month;
  const years=yearTerms(q).length ? yearTerms(q) : [String(new Date().getFullYear())];
  for(const y of years) out.push(`what-price-will-${name}-hit-in-${m}-${y}`);
  out.push(`what-price-will-${name}-hit-in-${m}`);
  for(const n of numberTargets(q)){
    const k=Number(n)%1000===0 ? `${Number(n)/1000}k` : n;
    for(const y of years){
      out.push(`will-${name}-reach-${k}-in-${m}-${y}`);
      out.push(`will-${name}-hit-${k}-in-${m}-${y}`);
    }
    out.push(`will-${name}-reach-${k}-in-${m}`);
    out.push(`will-${name}-hit-${k}-in-${m}`);
  }
  return out;
}
function priceLadderPageUrls(slug){
  const m=String(slug||'').match(/^will-(bitcoin|ethereum|solana|xrp|dogecoin|btc|eth|sol|doge)-(?:reach|hit)-([0-9]+k|[0-9]+m|[0-9]+)-in-([a-z]+)(?:-(20\d{2}))?$/);
  if(!m) return [];
  const name={btc:'bitcoin',eth:'ethereum',sol:'solana',doge:'dogecoin'}[m[1]]||m[1];
  const month=MONTHS[m[3]]||m[3];
  const parent=`what-price-will-${name}-hit-in-${month}`;
  return [...new Set([
    `https://polymarket.com/event/${parent}/${slug}`,
    m[4] ? `https://polymarket.com/event/${parent}-${m[4]}/${slug}` : null,
    `https://polymarket.com/event/${slug}`
  ].filter(Boolean))];
}
function deterministicSlugs(q){ const url=parseUrl(q), out=[]; if(url?.child) out.push(url.child); if(url?.parent) out.push(url.parent); out.push(...priceLadderSlugs(q)); const phrase=questionMarketPhrase(q); out.push(...phraseSlugVariants(phrase)); const termSlug=keyTerms(q).map(slugify).filter(Boolean).join('-'); if(termSlug) out.push(termSlug,...phraseSlugVariants(termSlug)); const subs=subjectTerms(q).map(slugify).filter(Boolean), sub=subs[0], fullSub=subs.join('-'), s=String(q).toLowerCase(); if(/\bby\b/.test(s) && fullSub) out.push(`${fullSub}-by`); if(/\bout\b/.test(s)){ if(fullSub) out.push(`${fullSub}-out-by`); if(sub) out.push(`${sub}-out-by`); } const d=datePart(q); if(!d||!sub) return expandSlugVariants(out); const date=`${d.month}-${d.day}`; if(/\bout\b/.test(s)) out.push(`${sub}-out-by-${date}`,`${sub}-out-before-2027`); out.push(`${fullSub}-by-${date}`); return expandSlugVariants(out); }
function canonicalTerms(q){ return [...new Set(keyTerms(q).map(canonicalTerm).filter(Boolean))]; }
function relaxedQueries(q){
  const anchor=requiredCapitalTerm(q), years=yearTerms(q), d=datePart(q);
  const terms=canonicalTerms(q).filter(t=>t && !FILLER.has(t) && !GENERIC.has(t) && !MONTHS[t]);
  const anchorTerms=anchor ? terms.filter(t=>t===anchor || termVariants(t).includes(anchor) || termVariants(anchor).includes(t)) : [];
  const rest=terms.filter(t=>!anchorTerms.includes(t) && !/^20\d{2}$/.test(t) && !(d && (t===d.short || t===d.day)));
  const required=[anchor,...years].filter(Boolean);
  if(d) required.push(d.short,d.day);
  if(!anchor) return [];
  const out=[];
  for(const t of rest) out.push([...required,t].join(' '));
  for(let i=0;i<rest.length;i++) for(let j=i+1;j<rest.length;j++) out.push([...required,rest[i],rest[j]].join(' '));
  if(rest.length>=3) out.push([...required,...rest.slice(0,3)].join(' '));
  return [...new Set(out.map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean))];
}
function searchQueriesFor(q, parsed={}){ const terms=keyTerms(q), canon=canonicalTerms(q), subs=subjectTerms(q), phrase=questionMarketPhrase(q); const price=priceLadderSlugs(q).map(s=>s.replace(/-/g,' ')); const canonicalPhrase=canon.join(' '); const base=[...price,terms.join(' '),canonicalPhrase,subs.join(' '),phrase,phrase.replace(/^(will|can|does|do|did|is|are|was|were|has|have)\s+/i,''),'will '+phrase,...relaxedQueries(q)].filter(Boolean); const ai=Array.isArray(parsed.searchQueries)?parsed.searchQueries:[]; return [...new Set([...ai,...base].map(s=>String(s||'').trim()).filter(Boolean))].slice(0,12); }
async function fetchExactSlug(q,slug){ const page='https://polymarket.com/event/'+slug; const urls=[`https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`,`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,`https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`,`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`]; const batches=await Promise.all(urls.map(u=>safeJson(u,2500))); for(const data of batches){ const ranked=rankedMarkets(q,marketsFrom(data),slug); if(ranked.length) return {market:ranked[0].m,markets:ranked.map(x=>x.m),url:page}; } for(const pageUrl of priceLadderPageUrls(slug).concat(page)){ const html=await safeText(pageUrl,2500); if(html && !pageLooksEnded(html)){ const text=cleanText(html); const title=cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||[])[1]) || cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]).replace(/\s*(?:Predictions|Trading Odds).*$/i,'') || slug.replace(/-/g,' '); const chance=(text.match(/((?:<\s*)?\d{1,3}(?:\.\d+)?)%\s*chance/i)||[])[1]?.replace(/\s+/g,'') || (text.match(/Buy\s+Yes\s+(\d+(?:\.\d+)?)\s*(?:c|cent)/i)||[])[1]; const pseudo={question:title+' '+slug.replace(/-/g,' '),slug,outcomes:'["Yes","No"]',outcomePrices:'["0.5","0.5"]'}; if(title && score(q,pseudo,slug)>0) return {pageOnly:true,title:(title+' '+slug.replace(/-/g,' ')).trim(),oddsText:chance?(chance.includes('<')?chance:chance+'%'):'?',url:pageUrl}; } } return null; }
async function publicSearchMarkets(queries){ const urls=[]; for(const q of [...new Set((queries||[]).filter(Boolean))]) urls.push(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}`); const data=await Promise.all(urls.map(u=>safeJson(u,3000))); return uniqueMarkets(data.flatMap(marketsFrom)); }
async function legacySearchMarkets(queries){ const urls=[]; for(const q of [...new Set((queries||[]).filter(Boolean))]) urls.push(`https://gamma-api.polymarket.com/events?limit=25&search=${encodeURIComponent(q)}`,`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=25&search=${encodeURIComponent(q)}`); const data=await Promise.all(urls.map(u=>safeJson(u,3000))); return uniqueMarkets(data.flatMap(marketsFrom)); }
async function searchMarkets(queries){ return uniqueMarkets([...(await publicSearchMarkets(queries)), ...(await legacySearchMarkets(queries))]); }
async function resolvePolymarketMarket(input, opts={}){ const q=String(input||'').trim(); const slugs=[...new Set([...deterministicSlugs(q),...(opts.slug?[opts.slug]:[])].filter(Boolean))].slice(0,12); for(const slug of slugs){ const exact=await fetchExactSlug(q,slug); if(exact?.market) return exact; } const candidates=rankedMarkets(q,await searchMarkets(searchQueriesFor(q,opts))).map(x=>x.m); return candidates.length ? {market:candidates[0],markets:candidates,url:null} : null; }
async function groqJson(prompt,fb){ const key=process.env.GROQ_API_KEY; if(!key) return fb; try{ const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},signal:AbortSignal.timeout(5000),body:JSON.stringify({model:'llama-3.1-8b-instant',temperature:0,max_tokens:250,messages:[{role:'user',content:prompt}]})}); if(!r.ok) return fb; const raw=((await r.json()).choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim(); const m=raw.match(/\{[\s\S]*\}/); return JSON.parse(m?m[0]:raw); }catch{return fb;} }
function marketUrl(m,urlOverride){ const slug=m?.slug||m?.market_slug||''; return urlOverride||(slug?'https://polymarket.com/event/'+slug:'https://polymarket.com'); }
function answerFrom(m,outcome,urlOverride){ const title=marketTitle(m), o=displayOutcome(m,outcome), url=marketUrl(m,urlOverride); return {ok:true,kind:'polymarket',answer:`${o.name||'Outcome'} is trading at ${formatOdds(o.price)} on Polymarket for: ${title}`,sources:[{domain:'polymarket',title:title.slice(0,90),url}],headlines:[]}; }
function answerFromMany(q,markets,outcome,urlOverride){ const shown=filterTopCluster(q,markets); const lines=shown.map(m=>{ const o=displayOutcome(m,outcome); return `${o.name||'Outcome'} ${formatOdds(o.price)} - ${marketTitle(m)}`; }); return {ok:true,kind:'polymarket',answer:`I found ${shown.length} matching Polymarket markets:\n`+lines.join('\n'),sources:shown.map(m=>({domain:'polymarket',title:marketTitle(m).slice(0,90),url:marketUrl(m,urlOverride)})),headlines:[]}; }
function debugMarket(m,q){ return {title:marketTitle(m).slice(0,120),question:String(m?.question||'').slice(0,120),slug:m?.slug||m?.market_slug||null,group:m?.groupItemTitle||m?.groupItem||m?.groupTitle||null,ended:marketEnded(m),prices:m?.outcomePrices||null,score:score(q,m)}; }
function debugAnswer(q,slugs,queries,markets){ const data={subjects:subjectTerms(q),requiredCapital:requiredCapitalTerm(q),date:datePart(q),triedSlugs:slugs.slice(0,20),searchQueries:queries.slice(0,20),rawCandidates:uniqueMarkets(markets).slice(0,15).map(m=>debugMarket(m,q))}; return {ok:false,kind:'polymarket',answer:'I could not find a Polymarket market that matches the subject/topic/date in your question.\n\nDebug data for Codex:\n'+JSON.stringify(data,null,2).slice(0,3200),sources:[],headlines:[],debug:data}; }
async function answerPolymarketOddsQuestion(q){ const queries=searchQueriesFor(q); const parsed=await groqJson('Parse Polymarket odds question as JSON {"searchQueries":[queries],"outcome":"Yes/No/exact outcome","slugCandidates":[event slugs]}. Question: '+q,{searchQueries:queries,outcome:'Yes',slugCandidates:[]}); const slugs=[...new Set([...deterministicSlugs(q),...(Array.isArray(parsed.slugCandidates)?parsed.slugCandidates:[])].filter(Boolean))].slice(0,12); for(const slug of slugs){ const ex=await fetchExactSlug(q,slug); if(ex?.markets?.length>1) return answerFromMany(q,ex.markets,parsed.outcome||'Yes',ex.url); if(ex?.market) return answerFrom(ex.market,parsed.outcome||'Yes',ex.url); if(ex?.pageOnly){ const shown=pageOnlyDisplay(ex); return {ok:true,kind:'polymarket',answer:`${shown.name} is trading at ${shown.oddsText} on Polymarket for: ${ex.title}`,sources:[{domain:'polymarket',title:ex.title.slice(0,90),url:ex.url}],headlines:[]}; } } const debugQueries=searchQueriesFor(q,parsed), searched=await searchMarkets(debugQueries), candidates=rankedMarkets(q,searched).map(x=>x.m); if(!candidates.length) return debugAnswer(q,slugs,debugQueries,searched); if(candidates.length>1) return answerFromMany(q,candidates,parsed.outcome||'Yes'); return answerFrom(candidates[0],parsed.outcome||'Yes'); }
module.exports={isPolymarketOddsQuestion,answerPolymarketOddsQuestion,resolvePolymarketMarket,outcomes,pickOutcome};
