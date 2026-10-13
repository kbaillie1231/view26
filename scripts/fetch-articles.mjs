// Fetches the official article page for every session linked from the program
// and extracts its description and speaker photos into data/articles.json.
//
// By default only articles missing from data/articles.json are fetched, so the
// frequent program sync makes at most a handful of requests. --all refreshes
// every article; --daily does the same at most once per (UTC) day, tracked in
// data/articles-refreshed.txt. If the site stops answering, the script gives
// up early and keeps what it already has, so the program sync still runs.
//
// Usage:
//   node scripts/fetch-articles.mjs [--all | --daily]
//   node scripts/fetch-articles.mjs --from-dir data/samples   (offline test: reads article_<id>.html)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';

const PROGRAM = 'data/source/view_CET.html';
const OUTPUT = 'data/articles.json';
const STAMP = 'data/articles-refreshed.txt';
const TIMEOUT_MS = 15000;
const MAX_CONSECUTIVE_FAILURES = 5;
const BASE = 'https://www.viewconference.it';
const UA = 'Mozilla/5.0 (compatible; view26-program-sync)';
const DELAY_MS = 250;

const args = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);
const refreshAll = args.includes('--all') || (args.includes('--daily') && (!existsSync(STAMP) || readFileSync(STAMP, 'utf8').trim() !== today));
const fromDirIdx = args.indexOf('--from-dir');
const fromDir = fromDirIdx >= 0 ? args[fromDirIdx + 1] : null;

const clean = (s) => (s || '').replace(/ /g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function extractArticle(html) {
  const $ = load(html);
  const $root = $('.article-body-content').first();
  if (!$root.length) return null;
  $root.find('br').replaceWith('\n');

  const lede = clean($root.children('description').text());

  const photos = {};
  $root.find('a.speaker-info').each((_, a) => {
    const slug = ($(a).attr('href') || '').split('/speaker/')[1];
    const src = $(a).find('.speaker-pic img').attr('src');
    if (slug && src && /^https:\/\//.test(src)) photos[decodeURIComponent(slug)] = src;
  });

  const body = [];
  const BLOCK = 'p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote';
  const walk = (el) => {
    $(el)
      .children()
      .each((_, child) => {
        const $c = $(child);
        if ($c.is('description, .meta, .event-info, script, style, iframe, .add-this')) return;
        if ($c.is('h1, h2, h3, h4, h5, h6')) {
          const t = clean($c.text());
          if (t) body.push({ h: t });
        } else if ($c.children(BLOCK).length) {
          walk(child);
        } else {
          const t = clean($c.text());
          if (t) body.push({ p: $c.is('li') ? `• ${t}` : t });
        }
      });
  };
  walk($root);

  // Drop a leading paragraph that just repeats the lede.
  if (lede && body[0] && body[0].p === lede) body.shift();
  return { lede, body, photos };
}

async function fetchArticle(id) {
  if (fromDir) {
    const file = join(fromDir, `article_${id}.html`);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/article/${id}`, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return await res.text();
      console.warn(`article ${id}: HTTP ${res.status}`);
      if (res.status === 404) return null;
    } catch (err) {
      console.warn(`article ${id}: ${err.message}`);
    }
    await sleep(1000 * attempt);
  }
  return null;
}

async function main() {
  const programHtml = readFileSync(PROGRAM, 'utf8');
  const ids = [...new Set([...programHtml.matchAll(/viewconference\.it\/article\/(\d+)/g)].map((m) => m[1]))].sort((a, b) => a - b);
  const existing = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, 'utf8')) : {};
  const out = {};
  let fetched = 0;
  let failed = 0;
  let streak = 0;
  for (const id of ids) {
    const giveUp = streak >= MAX_CONSECUTIVE_FAILURES;
    if (giveUp || (!refreshAll && !fromDir && existing[id])) {
      if (existing[id]) out[id] = existing[id];
      continue;
    }
    const html = await fetchArticle(id);
    const article = html ? extractArticle(html) : null;
    if (article) {
      out[id] = article;
      fetched++;
      streak = 0;
    } else {
      if (existing[id]) out[id] = existing[id];
      if (!fromDir) {
        failed++;
        streak++;
      }
    }
    if (!fromDir) await sleep(DELAY_MS);
  }
  writeFileSync(OUTPUT, JSON.stringify(out, null, 1) + '\n');
  if (refreshAll && !fromDir && streak < MAX_CONSECUTIVE_FAILURES) writeFileSync(STAMP, `${today}\n`);
  if (streak >= MAX_CONSECUTIVE_FAILURES) console.warn(`Gave up after ${MAX_CONSECUTIVE_FAILURES} failures in a row; kept existing articles`);
  console.log(`Articles: ${ids.length} linked, ${fetched} fetched, ${failed} failed, ${Object.keys(out).length} stored in ${OUTPUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
