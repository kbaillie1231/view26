// Parses the official VIEW Conference program page (data/source/view_CET.html)
// into site/data/program.json. Exits non-zero if the page doesn't look like a
// complete program, so a bad fetch never replaces good data.
//
// Usage: node scripts/parse-program.mjs [input.html] [output.json]

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from 'cheerio';

const INPUT = process.argv[2] || 'data/source/view_CET.html';
const OUTPUT = process.argv[3] || 'site/data/program.json';
const ARTICLES = 'data/articles.json';
const ICS_DIR = join(dirname(OUTPUT), '..', 'ics');
const SOURCE_URL = 'https://www.viewconference.it/assets/html/view_CET.html';
const MIN_SESSIONS = 60;

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

const errors = [];
const warnings = [];

const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
const pad = (n) => String(n).padStart(2, '0');
const norm = (s) => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const slugify = (s) => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function speakerKey(url) {
  const slug = decodeURIComponent((url || '').split('/speaker/')[1] || '').replace(/&#34;|"/g, '');
  return norm(slug);
}

function titleCase(upper) {
  return clean(upper).toLowerCase().replace(/(^|[\s\-'’(."])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
}

function articleId(url) {
  const m = /\/article\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

const html = readFileSync(INPUT, 'utf8');
const $ = load(html);

const pageTitle = clean($('title').text());
const yearMatch = /(20\d\d)/.exec(pageTitle);
if (!yearMatch) errors.push(`Could not find the year in page title "${pageTitle}"`);
const YEAR = yearMatch ? Number(yearMatch[1]) : 0;

// Header notes (locations, ticket notes) are repeated under each day heading;
// take them from the first one.
const headerNotes = [];
$('center').first().nextAll('center').first().find('span').each((_, el) => {
  const t = clean($(el).text());
  if (t && !headerNotes.includes(t)) headerNotes.push(t);
});
const locationLine = headerNotes.find((t) => /Location/i.test(t)) || '';
const notes = headerNotes.filter((t) => /^NOTE/i.test(t)).map((t) => t.replace(/^NOTE\s*:\s*/i, ''));
const venues = locationLine
  .split('//')
  .map((part) => {
    const m = /^(.*?):\s*(.*)$/.exec(clean(part));
    return m ? { when: m[1], where: m[2] } : null;
  })
  .filter(Boolean);
if (!venues.length) warnings.push('Could not parse the venue/location line');

const updatedText = clean($('hr').last().nextAll('center').first().text()).replace(/^Updated\s+on\s+/i, '');

// ---------------------------------------------------------------------------
// Day grids
// ---------------------------------------------------------------------------
const days = [];
const sessions = [];
const speakers = new Map(); // key -> speaker

const MONTH_FROM_LIST = (() => {
  const m = /on \w{3} (\w{3}) \d{1,2} from/.exec($('body').text());
  return m && MONTHS[m[1]] ? MONTHS[m[1]] : null;
})();
if (!MONTH_FROM_LIST) errors.push('Could not determine the month from the topic lists');

$('div[class^="schedule"]').each((_, grid) => {
  const $grid = $(grid);
  const slots = $grid.children('span.track-slot');
  const dayLabel = clean(slots.first().text()); // e.g. "Mon 12"
  const dm = /^(\w{3})\s+(\d{1,2})$/.exec(dayLabel);
  if (!dm) {
    errors.push(`Unrecognised day label "${dayLabel}"`);
    return;
  }
  const date = `${YEAR}-${pad(MONTH_FROM_LIST)}-${pad(dm[2])}`;
  const rooms = slots
    .slice(1)
    .map((__, el) => clean($(el).text()))
    .get();
  const day = { date, label: dayLabel, weekday: dm[1], dayOfMonth: Number(dm[2]), rooms };
  days.push(day);

  $grid.children('div.session').each((__, el) => {
    const $s = $(el);
    const srcId = (/session-(\d+)/.exec($s.attr('class') || '') || [])[1] || null;
    const $title = $s.children('h3.session-title');
    const title = clean($title.text());
    const url = $title.find('a').attr('href') || null;

    const $time = $s.children('span.session-time');
    const roomText = clean($time.find('span.session-room').text());
    const timeText = clean($time.clone().children().remove().end().text());
    const tm = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+(\w+)\s+\[(.+?)(?:\s+in\s+(\w+))?\]$/.exec(timeText);
    if (!tm) {
      errors.push(`Session "${title}" on ${date}: unrecognised time "${timeText}"`);
      return;
    }
    const start = `${pad(tm[1])}:${tm[2]}`;
    const end = `${pad(tm[3])}:${tm[4]}`;
    const typeLabel = clean(tm[6]);
    const language = tm[7] || null;

    const rm = /^In\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(roomText);
    if (!rm) errors.push(`Session "${title}" on ${date}: unrecognised room "${roomText}"`);
    const roomFull = rm ? clean(rm[1]) : roomText;
    const attendance = rm && rm[2] ? rm[2] : null;
    // "CINEMA MASSIMO - Via Giuseppe Verdi, 18" -> room "CINEMA MASSIMO"
    const room = roomFull.split(' - ')[0];

    const speakerIds = [];
    const moderatorIds = [];
    const sessionNotes = [];
    let nextIsModerator = false;
    $s.children().each((___, child) => {
      const $c = $(child);
      if ($c.is('span.session-presenter')) {
        const $a = $c.children('a').first();
        const purl = $a.attr('href') || null;
        const upperName = clean($a.text() || $c.clone().children('span').remove().end().text().replace(/,$/, ''));
        const ptitle = clean($c.children('span.session-presenter-title').text());
        const key = purl ? speakerKey(purl) : norm(upperName);
        if (!key) {
          errors.push(`Session "${title}": presenter without name`);
          return;
        }
        if (!speakers.has(key)) {
          speakers.set(key, { id: key, name: titleCase(upperName), title: ptitle, url: purl, sessions: [] });
        }
        (nextIsModerator ? moderatorIds : speakerIds).push(key);
        nextIsModerator = false;
      } else if ($c.is('span') && !$c.attr('class') && /^moderators?$/i.test(clean($c.text()))) {
        nextIsModerator = true;
      } else if ($c.is('div')) {
        const t = clean($c.text()).replace(/^\((.*)\)$/, '$1');
        if (t) sessionNotes.push(t);
      }
    });

    if (!title) errors.push(`Session ${srcId} on ${date}: missing title`);
    if (!speakerIds.length && !moderatorIds.length) warnings.push(`Session "${title}" on ${date}: no presenters`);
    if (start >= end) errors.push(`Session "${title}" on ${date}: start ${start} is not before end ${end}`);

    sessions.push({
      id: null,
      srcId,
      date,
      start,
      end,
      title,
      url,
      typeLabel,
      type: null,
      language,
      room,
      roomFull,
      attendance,
      notes: sessionNotes,
      separateTicket: /separate ticket/i.test(title + ' ' + sessionNotes.join(' ')),
      speakers: speakerIds,
      moderators: moderatorIds,
      topics: [],
    });
  });
});

// Base session type: "4-hour Workshop" -> "Workshop", "World Premiere Talk" -> "Talk".
const TYPE_ORDER = ['Keynote', 'Talk', 'Panel', 'Masterclass', 'Workshop', 'Lab', 'Screening', 'Portfolio Reviews', 'Ask Me Anything', 'Signing'];
for (const s of sessions) {
  const known = TYPE_ORDER.find((t) => new RegExp(`\\b${t}$`, 'i').test(s.typeLabel));
  s.type = known || s.typeLabel;
  if (!known) warnings.push(`Session "${s.title}": new session type "${s.typeLabel}" (kept as-is)`);
}

// Venue per session, from the location line on the page.
function venueFor(s) {
  if (/^CINEMA MASSIMO/i.test(s.roomFull)) return 'Cinema Massimo';
  const day = Number(s.date.slice(-2));
  for (const v of venues) {
    const days = (v.when.match(/\d+/g) || []).map(Number);
    if (days.includes(day)) return clean(v.where.split(/\s+-\s+|,/)[0]);
  }
  return null;
}
for (const s of sessions) {
  s.venue = venueFor(s);
  if (!s.venue) warnings.push(`Session "${s.title}" on ${s.date}: could not determine venue`);
}

// Stable ids: the official article id when unique, otherwise title + date.
const idCounts = new Map();
for (const s of sessions) {
  const a = articleId(s.url);
  s.id = a ? `a${a}` : `${slugify(s.title)}-${s.date.slice(-2)}`;
  idCounts.set(s.id, (idCounts.get(s.id) || 0) + 1);
}
for (const s of sessions) {
  if (idCounts.get(s.id) > 1) s.id = `${s.id}-${s.date.slice(-2)}-${s.start.replace(':', '')}`;
}
const finalIds = new Set();
for (const s of sessions) {
  if (finalIds.has(s.id)) errors.push(`Duplicate session id ${s.id}`);
  finalIds.add(s.id);
}

// ---------------------------------------------------------------------------
// Topic lists ("Animation Sessions", "Games Sessions", ...) and speaker index
// ---------------------------------------------------------------------------
const LIST_ITEM = /^(.+?)\s+on\s+(\w{3})\s+(\w{3})\s+(\d{1,2})\s+from\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+\w+\s+in\s+(.+?)(?:\s+room|\s+\(([^)]+)\))$/;

function findSession(liText, $li) {
  const m = LIST_ITEM.exec(clean(liText));
  if (!m) return { error: `Unrecognised list item "${clean(liText)}"` };
  const date = `${YEAR}-${pad(MONTHS[m[3]])}-${pad(m[4])}`;
  const start = m[5].padStart(5, '0');
  const end = m[6].padStart(5, '0');
  const roomFull = clean(m[7]);
  const title = clean($li.children('i, a').first().text());
  const candidates = sessions.filter((s) => s.date === date && s.start === start && s.roomFull === roomFull);
  if (candidates.length !== 1) {
    return { error: `List item "${title}" (${date} ${start} ${roomFull}) matched ${candidates.length} sessions` };
  }
  const s = candidates[0];
  if (s.end !== end) warnings.push(`"${title}": end time ${end} in list vs ${s.end} in grid`);
  if (norm(s.title) !== norm(title)) warnings.push(`List title "${title}" differs from grid title "${s.title}"`);
  return { session: s };
}

const topics = [];
$('a[name]').each((_, a) => {
  const key = $(a).attr('name');
  if (!key || key === 'top' || /^day\d+$/.test(key) || key === 'sessions-by-speaker') return;
  const $h3 = $(a).next('h3');
  const label = clean($h3.find('a').first().text() || $h3.text()).replace(/\s+Sessions$/i, '');
  const $list = $h3.next('div').children('ul').first();
  let count = 0;
  $list.children('li').each((__, li) => {
    const $li = $(li);
    const r = findSession($li.text(), $li);
    if (r.error) {
      errors.push(`Topic "${label}": ${r.error}`);
      return;
    }
    if (!r.session.topics.includes(key)) r.session.topics.push(key);
    count++;
  });
  topics.push({ key, label, count });
});
if (topics.length < 3) errors.push(`Only found ${topics.length} topic lists`);

// Speaker index: gives proper-case names and canonical titles, and lets us
// cross-check every speaker's sessions against the day grids.
let indexedSpeakers = 0;
const $speakerList = $('a[name="sessions-by-speaker"]').next('h3').next('div').children('ul').first();
$speakerList.children('li').each((_, li) => {
  const $li = $(li);
  const $a = $li.children('a').first();
  const key = speakerKey($a.attr('href'));
  const name = clean($a.text());
  const title = clean($li.clone().children('ul, a').remove().end().text()).replace(/^-\s*/, '');
  indexedSpeakers++;
  const sp = speakers.get(key);
  if (!sp) {
    warnings.push(`Speaker index lists "${name}" who is not in any day grid`);
    return;
  }
  sp.name = name;
  if (title) sp.title = title;
  $li.find('ul > li').each((__, sli) => {
    const r = findSession($(sli).text(), $(sli));
    if (r.error) {
      warnings.push(`Speaker "${name}": ${r.error}`);
      return;
    }
    const s = r.session;
    if (!s.speakers.includes(key) && !s.moderators.includes(key)) {
      warnings.push(`Speaker index puts "${name}" in "${s.title}" but the grid doesn't list them`);
    }
  });
});

for (const s of sessions) {
  for (const k of [...s.speakers, ...s.moderators]) speakers.get(k).sessions.push(s.id);
}

// ---------------------------------------------------------------------------
// Descriptions and speaker photos from the article pages (scripts/fetch-articles.mjs)
// ---------------------------------------------------------------------------
const articles = existsSync(ARTICLES) ? JSON.parse(readFileSync(ARTICLES, 'utf8')) : {};
const photos = new Map();
for (const art of Object.values(articles)) {
  for (const [slug, src] of Object.entries(art.photos || {})) photos.set(norm(slug.replace(/"/g, '')), src);
}
let described = 0;
for (const s of sessions) {
  const art = articles[articleId(s.url)];
  s.lede = art ? art.lede || '' : '';
  s.body = art ? art.body || [] : [];
  if (s.lede || s.body.length) described++;
}
for (const sp of speakers.values()) sp.photo = photos.get(sp.id) || null;

// ---------------------------------------------------------------------------
// Sanity checks and output
// ---------------------------------------------------------------------------
if (sessions.length < MIN_SESSIONS) errors.push(`Only ${sessions.length} sessions found (expected at least ${MIN_SESSIONS})`);
if (days.length < 3) errors.push(`Only ${days.length} days found`);

sessions.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.room.localeCompare(b.room));
for (const s of sessions) delete s.srcId;

const usedTypes = TYPE_ORDER.filter((t) => sessions.some((s) => s.type === t));
for (const s of sessions) if (!usedTypes.includes(s.type)) usedTypes.push(s.type);

// Sort by surname, ignoring honorifics and post-nominals ("Michael McCusker ACE").
const SUFFIXES = new Set(['ace', 'asc', 'bsc', 'cbe', 'ias', 'jr', 'sr', 'ii', 'iii', 'phd', 'ves', 'csc', 'gsc']);
const surname = (n) => {
  const words = n.replace(/"[^"]*"/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) words.pop();
  return words[words.length - 1] || n;
};
const speakerList = [...speakers.values()].sort(
  (a, b) => surname(a.name).localeCompare(surname(b.name), 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name, 'en'),
);

const out = {
  conference: pageTitle.replace(/\s*Program.*$/i, ''),
  source: { url: SOURCE_URL, updated: updatedText || null },
  timeZone: 'Europe/Rome',
  notes,
  venues,
  days,
  topics,
  types: usedTypes,
  speakers: speakerList,
  sessions,
};

console.log(`Days: ${days.map((d) => `${d.label} (${sessions.filter((s) => s.date === d.date).length})`).join(', ')}`);
console.log(`Sessions: ${sessions.length}, speakers: ${speakerList.length} (index lists ${indexedSpeakers})`);
console.log(`Topics: ${topics.map((t) => `${t.label} ${t.count}`).join(', ')}`);
console.log(`Sessions without a topic: ${sessions.filter((s) => !s.topics.length).length}`);
console.log(`Sessions with a description: ${described}; speakers with a photo: ${speakerList.filter((s) => s.photo).length}`);
console.log(`Source updated: ${out.source.updated}`);
for (const w of warnings) console.warn(`WARN: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR: ${e}`);
  console.error(`\n${errors.length} error(s); not writing ${OUTPUT}`);
  process.exit(1);
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(out, null, 1) + '\n');
console.log(`Wrote ${OUTPUT}`);

// One .ics per session, served as a real file so phones open it straight
// into the calendar app.
rmSync(ICS_DIR, { recursive: true, force: true });
mkdirSync(ICS_DIR, { recursive: true });
for (const s of sessions) writeFileSync(join(ICS_DIR, `${s.id}.ics`), sessionIcs(s));
console.log(`Wrote ${sessions.length} calendar files to ${ICS_DIR}`);

function romeToUtc(date, time) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    guess += wall - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(guess);
}

function sessionIcs(s) {
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escText = (t) => String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const fold = (line) => {
    const parts = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const b = Buffer.byteLength(ch);
      if (bytes + b > 74) {
        parts.push(cur);
        cur = ' ';
        bytes = 1;
      }
      cur += ch;
      bytes += b;
    }
    parts.push(cur);
    return parts.join('\r\n');
  };
  const venue = venues.find((v) => norm(v.where).startsWith(norm(s.venue || '').slice(0, 3)));
  const people = [...s.speakers, ...s.moderators].map((k) => speakers.get(k)).map((p) => `${p.name}${p.title ? ` (${p.title})` : ''}`).join(', ');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//view26//VIEW 2026 program//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${s.id}@view26-program`,
    'DTSTAMP:20261001T000000Z',
    `DTSTART:${stamp(romeToUtc(s.date, s.start))}`,
    `DTEND:${stamp(romeToUtc(s.date, s.end))}`,
    `SUMMARY:${escText(s.title)}`,
    `LOCATION:${escText(`${s.room}, ${venue ? venue.where : s.venue}`)}`,
    `DESCRIPTION:${escText(`${s.typeLabel}${people ? ` with ${people}` : ''}${s.url ? `\n${s.url}` : ''}`)}`,
    ...(s.url ? [`URL:${s.url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
