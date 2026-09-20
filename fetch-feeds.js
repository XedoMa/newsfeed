#!/usr/bin/env node
/**
 * Reads feeds.json, fetches every RSS feed, resolves Google News' encoded
 * redirect links to the real publisher URL, finds an image for each article,
 * dedupes near-identical headlines, sorts newest-first, caps the list, and
 * writes news.json.
 *
 * Design goals (see CLAUDE.md RULES): no npm dependencies, one broken feed
 * or page must never stop the run, and image lookups are cached so repeat
 * runs (every 3h via GitHub Actions) only do work for genuinely new articles.
 *
 * Run it with:  node fetch-feeds.js
 */

const fs = require('fs');
const path = require('path');

const FEEDS_PATH = path.join(__dirname, 'feeds.json');
const OUTPUT_PATH = path.join(__dirname, 'news.json');
// Overridable so GitHub Actions can persist this outside the folder that
// gets deployed to Pages (see .github/workflows/deploy.yml).
const CACHE_DIR = process.env.NEWS_CACHE_DIR || path.join(__dirname, '.cache');
const CACHE_PATH = path.join(CACHE_DIR, 'article-cache.json');

const MAX_AGE_DAYS = 7;
const MAX_ITEMS_PER_TOPIC = 50;
const MAX_ITEMS_TOTAL = 150;
const FETCH_TIMEOUT_MS = 10000;
const CONCURRENCY = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function warn(...args) {
  console.warn(new Date().toISOString(), ...args);
}

async function fetchWithTimeout(url, options = {}) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return fetch(url, {
    ...options,
    signal,
    headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
  });
}

// Runs `worker` over `items` with at most `concurrency` in flight at once.
// A worker that throws just yields `undefined` for that item -- callers
// treat that the same as "couldn't get this one, move on".
async function runPool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne));
  return results;
}

// ---------- persistent cache (article id -> resolved URL / image) ----------

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ---------- minimal hand-rolled RSS parsing (no XML library needed) ----------

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return null;
  let val = m[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) val = cdata[1];
  return decodeEntities(val.trim());
}

function extractAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    items.push({
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      pubDate: extractTag(block, 'pubDate'),
      source: extractTag(block, 'source') || extractAttr(block, 'source', 'url'),
      mediaImage: extractAttr(block, 'media:content', 'url') || extractAttr(block, 'enclosure', 'url'),
    });
  }
  return items;
}

// ---------- headline normalization + near-duplicate detection ----------

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/['’"“”]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(title) {
  return new Set(normalizeTitle(title).split(' ').filter((w) => w.length > 2));
}

function tokenOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap / Math.min(a.size, b.size);
}

// Two headlines covering the same story usually share most of their
// significant words even when the wording differs, so a token-overlap
// ratio catches these without needing a fuzzy-matching library.
function dedupe(articles) {
  const kept = [];
  const keptTokens = [];
  for (const article of articles) {
    const tokens = titleTokens(article.headline);
    const isDup = keptTokens.some((kt) => tokenOverlap(tokens, kt) > 0.75);
    if (!isDup) {
      kept.push(article);
      keptTokens.push(tokens);
    }
  }
  return kept;
}

// ---------- resolving Google News' encoded redirect links ----------
//
// Since mid-2024 Google News RSS links no longer embed the real URL --
// they're an opaque id you resolve via an internal RPC (`batchexecute`).
// The steps: fetch the article's Google News page to read a per-article
// signature + timestamp, then send those in a batched POST to get the
// real publisher URL back. If any step fails, the caller just keeps the
// original Google News link, which still opens the article in a browser.

function articleIdFromLink(link) {
  const m = link.match(/\/articles\/([^?]+)/);
  return m ? m[1] : null;
}

async function getSignature(link) {
  try {
    const res = await fetchWithTimeout(link);
    if (!res.ok) return null;
    const html = await res.text();
    const sg = html.match(/data-n-a-sg="([^"]+)"/);
    const ts = html.match(/data-n-a-ts="([^"]+)"/);
    if (!sg || !ts) return null;
    return { signature: sg[1], timestamp: ts[1] };
  } catch {
    return null;
  }
}

function buildRpcEntry(articleId, timestamp, signature, ceid, seq) {
  const inner = [
    'garturlreq',
    [
      ['X', 'X', ['X', 'X'], null, null, 1, 1, ceid, null, 1, null, null, null, null, null, 0, 1],
      'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
    ],
    articleId,
    Number(timestamp),
    signature,
  ];
  return ['Fbv4je', JSON.stringify(inner), null, seq];
}

async function resolveBatch(entries) {
  if (entries.length === 0) return {};
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([entries]));
  try {
    const res = await fetchWithTimeout('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Referer: 'https://news.google.com/',
      },
      body,
    });
    if (!res.ok) return {};
    const text = await res.text();
    const trimmed = text.replace(/^\)\]\}'\n?/, '').trim();
    const outer = JSON.parse(trimmed);
    const out = {};
    for (const row of outer) {
      if (!Array.isArray(row) || row.length < 7) continue;
      if (row[0] !== 'wrb.fr' || row[1] !== 'Fbv4je') continue;
      const payload = row[2];
      const seq = row[6];
      if (typeof payload !== 'string') continue;
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed) && parsed[0] === 'garturlres' && typeof parsed[1] === 'string') {
          out[seq] = parsed[1];
        }
      } catch {
        // one malformed row shouldn't drop the rest of the batch
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function resolveGoogleLinks(articles, cache) {
  const toResolve = [];
  for (const a of articles) {
    const aid = articleIdFromLink(a.link);
    if (!aid) continue;
    a._aid = aid;
    if (cache[aid] && cache[aid].resolvedUrl) {
      a.resolvedLink = cache[aid].resolvedUrl;
    } else {
      toResolve.push(a);
    }
  }
  if (toResolve.length === 0) return;

  log(`Resolving ${toResolve.length} new article link(s)...`);
  const sigResults = await runPool(toResolve, async (a) => {
    const sig = await getSignature(a.link);
    return { article: a, sig };
  });

  const entries = [];
  const seqToArticle = {};
  let seq = 0;
  for (const r of sigResults) {
    if (!r || !r.sig) continue;
    const s = String(seq++);
    entries.push(buildRpcEntry(r.article._aid, r.sig.timestamp, r.sig.signature, 'US:en', s));
    seqToArticle[s] = r.article;
  }

  // Batch in chunks so one oversized request can't fail the whole run.
  const CHUNK = 50;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const resolved = await resolveBatch(chunk);
    for (const [s, url] of Object.entries(resolved)) {
      const article = seqToArticle[s];
      article.resolvedLink = url;
      cache[article._aid] = cache[article._aid] || {};
      cache[article._aid].resolvedUrl = url;
    }
  }
}

// ---------- image lookup: feed image, else og:image, else none ----------

async function findOgImage(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const html = await res.text();
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function attachImages(articles, cache) {
  const needLookup = articles.filter((a) => !a.mediaImage);
  await runPool(needLookup, async (a) => {
    if (a._aid && cache[a._aid] && 'image' in cache[a._aid]) {
      a.image = cache[a._aid].image;
      return;
    }
    const target = a.resolvedLink || a.link;
    const image = await findOgImage(target);
    a.image = image;
    if (a._aid) {
      cache[a._aid] = cache[a._aid] || {};
      cache[a._aid].image = image;
    }
  });
  for (const a of articles) {
    if (a.mediaImage) a.image = a.mediaImage;
  }
}

// ---------- source name + headline cleanup ----------

function cleanSource(item) {
  if (item.source) return item.source.replace(/[\s-]+$/, '');
  const m = item.title && item.title.match(/ - ([^-]+)$/);
  return m ? m[1].trim() : 'Unknown';
}

function stripSourceSuffix(title, source) {
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

// ---------- main ----------

async function main() {
  const { feeds } = JSON.parse(fs.readFileSync(FEEDS_PATH, 'utf8'));
  const cache = loadCache();
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  let allArticles = [];

  for (const feed of feeds) {
    try {
      log(`Fetching feed: ${feed.label} (${feed.topic})`);
      const res = await fetchWithTimeout(feed.url);
      if (!res.ok) {
        warn(`  skipped, HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const items = parseRssItems(xml);
      log(`  got ${items.length} item(s)`);
      for (const item of items) {
        if (!item.title || !item.link || !item.pubDate) continue;
        const published = new Date(item.pubDate);
        if (Number.isNaN(published.getTime()) || published.getTime() < cutoff) continue;
        const source = cleanSource(item);
        allArticles.push({
          headline: stripSourceSuffix(item.title, source),
          link: item.link,
          source,
          topic: feed.topic,
          published: published.toISOString(),
          mediaImage: item.mediaImage || null,
        });
      }
    } catch (e) {
      warn(`  failed to fetch/parse feed "${feed.label}": ${e.message}`);
    }
  }

  log(`Total raw articles: ${allArticles.length}`);
  allArticles.sort((a, b) => new Date(b.published) - new Date(a.published));
  allArticles = dedupe(allArticles);
  log(`After dedupe: ${allArticles.length}`);

  const perTopicCount = {};
  const capped = [];
  for (const a of allArticles) {
    perTopicCount[a.topic] = (perTopicCount[a.topic] || 0) + 1;
    if (perTopicCount[a.topic] <= MAX_ITEMS_PER_TOPIC) capped.push(a);
  }
  const finalArticles = capped.slice(0, MAX_ITEMS_TOTAL);
  log(`After capping: ${finalArticles.length}`);

  await resolveGoogleLinks(finalArticles, cache);
  await attachImages(finalArticles, cache);
  saveCache(cache);

  const output = finalArticles.map((a) => ({
    headline: a.headline,
    link: a.resolvedLink || a.link,
    source: a.source,
    topic: a.topic,
    published: a.published,
    image: a.image || null,
  }));

  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), articles: output }, null, 2)
  );
  log(`Wrote ${output.length} articles to news.json`);
}

main().catch((e) => {
  console.error('Fatal error in fetch-feeds.js:', e);
  process.exit(1);
});
