'use strict';

(() => {
  const TZ = 'Europe/Rome';
  const PICKS_KEY = 'view26.picks';
  const DAY_KEY = 'view26.day';
  const MAPS = 'https://www.google.com/maps/search/?api=1&query=';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  const ICON = {
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5"/></svg>',
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let P = null;
  const byId = new Map();
  const speakerById = new Map();
  const topicByKey = new Map();
  const state = {
    day: null,
    q: '',
    topics: new Set(),
    types: new Set(),
    rooms: new Set(),
    speakers: new Set(),
    picksOnly: false,
  };
  let tokens = [];
  let picks = new Set(readJSON(localStorageSafe(), PICKS_KEY, []));
  let openSheet = null; // the <dialog> currently shown

  function localStorageSafe() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }
  function sessionStorageSafe() {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  }
  function readJSON(store, key, fallback) {
    try {
      const v = store && store.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  }
  function writeJSON(store, key, value) {
    try {
      store && store.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or blocked: picks still work for this visit */
    }
  }

  // ---------------------------------------------------------------------------
  // Time (everything is Turin wall-clock time)
  // ---------------------------------------------------------------------------
  const romeFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  function romeParts(date) {
    const p = Object.fromEntries(romeFmt.formatToParts(date).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  // ?now=2026-10-13T11:40 lets you preview the "live" state on any day.
  const nowOverride = new URLSearchParams(location.search).get('now');
  function now() {
    if (nowOverride && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(nowOverride)) {
      const [date, time] = nowOverride.split('T');
      return { date, time };
    }
    return romeParts(new Date());
  }
  function romeToUtc(date, time) {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const wall = Date.UTC(y, m - 1, d, hh, mm);
    let guess = wall;
    for (let i = 0; i < 2; i++) {
      const p = romeParts(new Date(guess));
      const [py, pm, pd] = p.date.split('-').map(Number);
      const [ph, pmin] = p.time.split(':').map(Number);
      guess += wall - Date.UTC(py, pm - 1, pd, ph, pmin);
    }
    return new Date(guess);
  }
  const icsStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const WEEKDAY = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
  const dayOf = (date) => P.days.find((d) => d.date === date);
  const dayShort = (date) => {
    const d = dayOf(date);
    return d ? `${d.weekday} ${d.dayOfMonth}` : date;
  };
  const dayLong = (date) => {
    const d = dayOf(date);
    return d ? `${WEEKDAY[d.weekday] || d.weekday} ${d.dayOfMonth} October` : date;
  };

  function statusOf(s, n) {
    if (s.date < n.date) return 'past';
    if (s.date > n.date) return 'future';
    if (s.end <= n.time) return 'past';
    if (s.start <= n.time) return 'live';
    return 'future';
  }
  function nextStartToday(n) {
    let next = null;
    for (const s of P.sessions) if (s.date === n.date && s.start > n.time && (!next || s.start < next)) next = s.start;
    return next;
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  function prepare(program) {
    P = program;
    P.days.forEach((d) => {
      const venues = {};
      for (const s of P.sessions) if (s.date === d.date && s.venue && !/cinema/i.test(s.venue)) venues[s.venue] = (venues[s.venue] || 0) + 1;
      d.venue = Object.keys(venues).sort((a, b) => venues[b] - venues[a])[0] || null;
    });
    P.topics.sort((a, b) => b.count - a.count);
    P.topics.forEach((t) => topicByKey.set(t.key, t));
    P.speakers.forEach((sp) => speakerById.set(sp.id, sp));
    for (const s of P.sessions) {
      byId.set(s.id, s);
      const people = [...s.speakers, ...s.moderators].map((id) => speakerById.get(id)).filter(Boolean);
      s._people = people;
      s._hayMain = fold([s.title, s.lede, ...people.map((p) => `${p.name} ${p.title}`)].join(' \n '));
      s._hayMeta = fold([s.room, s.venue, s.type, s.typeLabel, ...s.topics.map((k) => topicByKey.get(k)?.label), ...s.notes].join(' \n '));
      s._bodyText = (s.body || []).map((b) => b.p || b.h).join(' ');
      s._hayBody = fold(s._bodyText);
    }
    // Picks for sessions that no longer exist are kept (they may come back) but ignored.
  }

  function venueAddress(venueName) {
    const v = (P.venues || []).find((x) => fold(x.where).startsWith(fold(venueName || '').slice(0, 3)));
    return v ? v.where : venueName;
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------
  const hasFilters = () => state.topics.size || state.types.size || state.rooms.size || state.speakers.size;
  const finding = () => !!(tokens.length || hasFilters() || state.picksOnly);

  function matches(s, skip) {
    if (skip !== 'topics' && state.topics.size && !s.topics.some((t) => state.topics.has(t))) return false;
    if (skip !== 'types' && state.types.size && !state.types.has(s.type)) return false;
    if (skip !== 'rooms' && state.rooms.size && !state.rooms.has(s.room)) return false;
    if (skip !== 'speakers' && state.speakers.size && ![...s.speakers, ...s.moderators].some((id) => state.speakers.has(id))) return false;
    if (state.picksOnly && !picks.has(s.id)) return false;
    if (tokens.length && !tokens.every((t) => s._hayMain.includes(t) || s._hayMeta.includes(t) || s._hayBody.includes(t))) return false;
    return true;
  }
  const results = () => P.sessions.filter((s) => matches(s));
  const facetCount = (facet, test) => P.sessions.filter((s) => test(s) && matches(s, facet)).length;

  function conflictsFor(s) {
    if (!picks.has(s.id)) return [];
    return P.sessions.filter((o) => o !== s && picks.has(o.id) && o.date === s.date && o.start < s.end && s.start < o.end);
  }

  // ---------------------------------------------------------------------------
  // Highlighting
  // ---------------------------------------------------------------------------
  function highlight(text, toks = tokens) {
    text = String(text ?? '');
    if (!toks.length || !text) return esc(text);
    let folded = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const f = fold(text[i]);
      for (let k = 0; k < f.length; k++) {
        folded += f[k];
        map.push(i);
      }
    }
    const ranges = [];
    for (const t of toks) {
      let idx = folded.indexOf(t);
      while (idx !== -1) {
        ranges.push([map[idx], map[idx + t.length - 1] + 1]);
        idx = folded.indexOf(t, idx + t.length);
      }
    }
    if (!ranges.length) return esc(text);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [ranges[0]];
    for (const r of ranges.slice(1)) {
      const last = merged[merged.length - 1];
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }
    let out = '';
    let pos = 0;
    for (const [a, b] of merged) {
      out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
      pos = b;
    }
    return out + esc(text.slice(pos));
  }

  function snippet(s) {
    // Only when the match isn't visible on the card already.
    const visible = fold([s.title, ...s._people.map((p) => p.name), s.room, s.type].join(' '));
    const missing = tokens.filter((t) => !visible.includes(t));
    if (!missing.length) return '';
    for (const text of [s.lede, ...s._people.map((p) => `${p.name}: ${p.title}`), s._bodyText]) {
      const f = fold(text);
      const i = f.indexOf(missing[0]);
      if (i === -1) continue;
      const start = Math.max(0, i - 50);
      const end = Math.min(text.length, i + missing[0].length + 80);
      return (start > 0 ? '…' : '') + highlight(text.slice(start, end)) + (end < text.length ? '…' : '');
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // URL state
  // ---------------------------------------------------------------------------
  function readUrl() {
    const u = new URLSearchParams(location.search);
    const list = (k) => (u.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
    state.q = u.get('q') || '';
    state.topics = new Set(list('topic').filter((k) => topicByKey.has(k)));
    state.types = new Set(list('type').filter((t) => P.types.includes(t)));
    state.rooms = new Set(list('room'));
    state.speakers = new Set(list('speaker').filter((id) => speakerById.has(id)));
    state.picksOnly = u.get('picks') === '1';
    const day = u.get('day');
    if (day && dayOf(day)) state.day = day;
    tokens = fold(state.q).split(/\s+/).filter(Boolean);
    return u.get('s');
  }
  function buildUrl(sessionId) {
    const u = new URLSearchParams();
    if (state.q) u.set('q', state.q);
    if (state.topics.size) u.set('topic', [...state.topics].join(','));
    if (state.types.size) u.set('type', [...state.types].join(','));
    if (state.rooms.size) u.set('room', [...state.rooms].join(','));
    if (state.speakers.size) u.set('speaker', [...state.speakers].join(','));
    if (state.picksOnly) u.set('picks', '1');
    if (nowOverride) u.set('now', nowOverride);
    if (sessionId) u.set('s', sessionId);
    const qs = u.toString().replace(/%2C/g, ',');
    return location.pathname + (qs ? `?${qs}` : '');
  }
  function syncUrl() {
    const open = currentSessionId();
    history.replaceState(history.state, '', buildUrl(open));
  }
  const currentSessionId = () => new URLSearchParams(location.search).get('s');

  // ---------------------------------------------------------------------------
  // Rendering: day tabs, chips, list
  // ---------------------------------------------------------------------------
  function render() {
    renderDays();
    renderChips();
    renderList();
    renderNowButton();
    const count = state.topics.size + state.types.size + state.rooms.size + state.speakers.size;
    $('#filter-count').hidden = !count;
    $('#filter-count').textContent = count;
    $('#filter-btn').classList.toggle('active', !!count);
    $('#filter-btn').setAttribute('aria-label', count ? `Filters, ${count} active` : 'Filters');
    $('#clear-q').hidden = !state.q;
  }

  function renderDays() {
    const n = now();
    const f = finding();
    const counts = {};
    if (f) for (const s of results()) counts[s.date] = (counts[s.date] || 0) + 1;
    const nav = $('#days');
    nav.style.setProperty('--day-count', P.days.length);
    nav.classList.toggle('finding', f);
    nav.innerHTML = P.days
      .map((d) => {
        const selected = !f && d.date === state.day;
        const c = counts[d.date] || 0;
        const isToday = d.date === n.date;
        const label = `${WEEKDAY[d.weekday] || d.weekday} ${d.dayOfMonth} October${isToday ? ', today' : ''}${f ? `, ${plural(c, 'match', 'matches')}` : ''}`;
        return `<button type="button" class="day${isToday ? ' today' : ''}${f && !c ? ' zero' : ''}" data-day="${d.date}" aria-pressed="${selected}" aria-label="${esc(label)}">
          <span class="dow">${esc(d.weekday)}</span><span class="dom">${d.dayOfMonth}</span>
          ${f ? `<span class="count">${c}</span>` : isToday ? '<span class="today-dot"></span>' : ''}
        </button>`;
      })
      .join('');
  }

  function chip({ label, pressed, attrs = '', color, n, removable, disabled, cls = '' }) {
    const dot = color ? `<span class="dot" style="--c:var(--t-${color})"></span>` : '';
    const count = n != null ? `<span class="n">${n}</span>` : '';
    const x = removable ? ICON.x : '';
    return `<button type="button" class="chip${removable ? ' removable' : ''}${cls ? ` ${cls}` : ''}" ${pressed != null ? `aria-pressed="${pressed}"` : ''} ${disabled ? 'disabled' : ''} ${attrs}>${dot}${esc(label)}${count}${x}</button>`;
  }

  function renderChips() {
    const parts = [];
    parts.push(
      chip({
        label: `★ My picks${picks.size ? ` (${countValidPicks()})` : ''}`,
        pressed: state.picksOnly,
        attrs: 'data-act="picks"',
      }),
    );
    for (const k of state.topics) parts.push(chip({ label: topicByKey.get(k)?.label || k, color: k, removable: true, attrs: `data-remove="topics" data-value="${esc(k)}" aria-label="Remove filter ${esc(topicByKey.get(k)?.label || k)}"` }));
    for (const t of state.types) parts.push(chip({ label: t, removable: true, attrs: `data-remove="types" data-value="${esc(t)}" aria-label="Remove filter ${esc(t)}"` }));
    for (const r of state.rooms) parts.push(chip({ label: r, removable: true, attrs: `data-remove="rooms" data-value="${esc(r)}" aria-label="Remove filter ${esc(r)}"` }));
    for (const id of state.speakers) {
      const name = speakerById.get(id)?.name || id;
      parts.push(chip({ label: name, removable: true, attrs: `data-remove="speakers" data-value="${esc(id)}" aria-label="Remove filter ${esc(name)}"` }));
    }
    if (hasFilters() || state.picksOnly || state.q) parts.push(chip({ label: 'Clear all', cls: 'clear', attrs: 'data-act="clear"' }));
    for (const t of P.topics) {
      if (state.topics.has(t.key)) continue;
      const n = facetCount('topics', (s) => s.topics.includes(t.key));
      parts.push(chip({ label: t.label, color: t.key, n, pressed: false, disabled: !n, attrs: `data-toggle="topics" data-value="${esc(t.key)}"` }));
    }
    $('#chips-row').innerHTML = parts.join('');
  }

  const countValidPicks = () => [...picks].filter((id) => byId.has(id)).length;

  function speakersLine(s) {
    const sp = s.speakers.map((id) => speakerById.get(id)).filter(Boolean);
    const mods = s.moderators.map((id) => speakerById.get(id)).filter(Boolean);
    let html;
    if (sp.length === 1) {
      html = `<b>${highlight(sp[0].name)}</b>${sp[0].title ? `, ${highlight(sp[0].title)}` : ''}`;
    } else {
      const shown = sp.slice(0, 5).map((p) => `<b>${highlight(p.name)}</b>`);
      html = shown.join(', ') + (sp.length > 5 ? ` +${sp.length - 5} more` : '');
    }
    if (mods.length) html += `${html ? ' · ' : ''}Moderator: ${mods.map((p) => highlight(p.name)).join(', ')}`;
    return html;
  }

  function cardHtml(s, n, nextStart, showDay) {
    const st = statusOf(s, n);
    const isNext = st === 'future' && s.date === n.date && s.start === nextStart;
    const pills = [];
    if (st === 'live') pills.push('<span class="pill live">Live</span>');
    else if (isNext) pills.push('<span class="pill next">Next</span>');
    if (s.separateTicket) pills.push('<span class="pill ticket">Separate ticket</span>');
    const conflicts = conflictsFor(s);
    const snip = tokens.length ? snippet(s) : '';
    const picked = picks.has(s.id);
    return `<article class="card${st === 'live' ? ' live' : ''}${st === 'past' && s.date === n.date ? ' past' : ''}" id="c-${esc(s.id)}" data-id="${esc(s.id)}">
      <div class="card-open">
        <div class="meta">
          <span class="time">${showDay ? `${esc(dayShort(s.date))} · ` : ''}<time datetime="${s.date}T${s.start}">${s.start}</time>–${s.end}</span>
          <span class="room">${highlight(s.room)}</span>
          <span class="type">${highlight(s.typeLabel)}</span>
          ${pills.join('')}
        </div>
        <h3><a class="card-link" href="${esc(buildUrl(s.id))}" data-open="${esc(s.id)}">${highlight(s.title)}</a></h3>
        <p class="who">${speakersLine(s)}</p>
        ${s.topics.length ? `<div class="tags">${s.topics.map((k) => `<span class="tag" style="--c:var(--t-${esc(k)})">${esc(topicByKey.get(k)?.label || k)}</span>`).join('')}</div>` : ''}
        ${snip ? `<p class="snippet">${snip}</p>` : ''}
        ${conflicts.length ? `<div class="conflict">Overlaps with ${conflicts.map((o) => `“${esc(o.title)}” (${o.start}–${o.end})`).join(', ')}</div>` : ''}
      </div>
      <button type="button" class="star-btn" data-star="${esc(s.id)}" aria-pressed="${picked}" aria-label="${picked ? 'Remove from' : 'Add to'} My picks: ${esc(s.title)}">${ICON.star}</button>
    </article>`;
  }

  function renderList() {
    const n = now();
    const nextStart = nextStartToday(n);
    const list = $('#list');
    const status = $('#status');

    if (!finding()) {
      const day = dayOf(state.day);
      const sessions = P.sessions.filter((s) => s.date === state.day);
      const venue = day.venue ? `${day.venue}` : '';
      status.innerHTML = `${esc(dayLong(state.day))}${venue ? ` · <a href="${MAPS + encodeURIComponent(venueAddress(venue))}" target="_blank" rel="noopener">${esc(venue)}</a>` : ''} · ${plural(sessions.length, 'session')}`;
      const groups = new Map();
      for (const s of sessions) {
        if (!groups.has(s.start)) groups.set(s.start, []);
        groups.get(s.start).push(s);
      }
      list.innerHTML = [...groups]
        .map(([start, items]) => {
          const allPast = state.day === n.date && items.every((s) => statusOf(s, n) === 'past');
          return `<section class="group${allPast ? ' past' : ''}" data-start="${start}">
            <h2 class="group-head"><time datetime="${state.day}T${start}">${start}</time><span class="sub">${plural(items.length, 'session')}</span></h2>
            ${items.map((s) => cardHtml(s, n, nextStart, false)).join('')}
          </section>`;
        })
        .join('');
      return;
    }

    const found = results();
    const days = [...new Set(found.map((s) => s.date))];
    const what = state.picksOnly && !tokens.length && !hasFilters() ? 'picked' : 'matching';
    status.innerHTML = found.length
      ? `${plural(found.length, `${what} session`)}${days.length > 1 ? ` across ${plural(days.length, 'day')}` : ''}`
      : '';

    if (!found.length) {
      list.innerHTML = emptyHtml();
      return;
    }
    list.innerHTML = days
      .map((date) => {
        const items = found.filter((s) => s.date === date);
        const d = dayOf(date);
        return `<section class="group" data-date="${date}" id="d-${date}">
          <h2 class="group-head day-head">${esc(dayLong(date))}<span class="sub">${d?.venue ? esc(d.venue) + ' · ' : ''}${plural(items.length, 'session')}</span></h2>
          ${items.map((s) => cardHtml(s, n, nextStart, false)).join('')}
        </section>`;
      })
      .join('');
  }

  function emptyHtml() {
    if (state.picksOnly && !tokens.length && !hasFilters()) {
      return `<div class="empty"><h2>No picks yet</h2><p>Tap ☆ on any session to save it here. Picks are stored on this device only.</p>
        <div class="actions"><button type="button" class="btn" data-act="picks">Browse the program</button></div></div>`;
    }
    const bits = [];
    if (state.q) bits.push(`“${esc(state.q)}”`);
    for (const k of state.topics) bits.push(esc(topicByKey.get(k)?.label || k));
    for (const t of state.types) bits.push(esc(t));
    for (const r of state.rooms) bits.push(esc(r));
    for (const id of state.speakers) bits.push(esc(speakerById.get(id)?.name || id));
    if (state.picksOnly) bits.push('My picks');
    const actions = [];
    if (state.q) actions.push('<button type="button" class="btn" data-act="clear-q">Clear search</button>');
    if (hasFilters() || state.picksOnly) actions.push('<button type="button" class="btn" data-act="clear-filters">Remove filters</button>');
    actions.push('<button type="button" class="btn primary" data-act="clear">Show everything</button>');
    return `<div class="empty"><h2>No sessions match</h2><p>${bits.join(' + ')}</p><div class="actions">${actions.join('')}</div></div>`;
  }

  function renderNowButton() {
    const n = now();
    const show = !finding() && state.day === n.date && P.sessions.some((s) => s.date === n.date && s.end > n.time);
    $('#now-btn').hidden = !show;
  }

  function jumpToNow() {
    const n = now();
    const groups = $$('#list .group[data-start]');
    // The first time slot that still has a session running or upcoming.
    const target = groups.find((g) => $$('.card', g).some((c) => statusOf(byId.get(c.dataset.id), n) !== 'past'));
    if (!target) return;
    const live = $('.card.live', target);
    (live || target).scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  // Live/Next badges change over the day; refresh once a minute without
  // rebuilding the page under the user's thumb.
  function tick() {
    if (!P) return;
    const n = now();
    const nextStart = nextStartToday(n);
    for (const card of $$('#list .card')) {
      const s = byId.get(card.dataset.id);
      if (!s) continue;
      const st = statusOf(s, n);
      card.classList.toggle('live', st === 'live');
      card.classList.toggle('past', st === 'past' && s.date === n.date);
      const meta = $('.meta', card);
      $$('.pill.live, .pill.next', meta).forEach((p) => p.remove());
      const isNext = st === 'future' && s.date === n.date && s.start === nextStart;
      if (st === 'live' || isNext) {
        const pill = document.createElement('span');
        pill.className = `pill ${st === 'live' ? 'live' : 'next'}`;
        pill.textContent = st === 'live' ? 'Live' : 'Next';
        const ticket = $('.pill.ticket', meta);
        meta.insertBefore(pill, ticket);
      }
    }
    for (const g of $$('#list .group[data-start]')) {
      g.classList.toggle('past', state.day === n.date && $$('.card', g).every((c) => statusOf(byId.get(c.dataset.id), n) === 'past'));
    }
    renderNowButton();
    renderDaysTodayMarker(n);
  }
  let lastToday = null;
  function renderDaysTodayMarker(n) {
    if (lastToday && lastToday !== n.date) renderDays();
    lastToday = n.date;
  }

  // ---------------------------------------------------------------------------
  // Session sheet
  // ---------------------------------------------------------------------------
  function sessionSheetHtml(s) {
    const n = now();
    const st = statusOf(s, n);
    const picked = picks.has(s.id);
    const conflicts = conflictsFor(s);
    const address = venueAddress(s.venue);
    const people = [
      ...s.speakers.map((id) => ({ sp: speakerById.get(id), mod: false })),
      ...s.moderators.map((id) => ({ sp: speakerById.get(id), mod: true })),
    ].filter((x) => x.sp);
    const peopleHtml = people
      .map(({ sp, mod }) => {
        const others = sp.sessions.filter((id) => id !== s.id && byId.has(id)).map((id) => byId.get(id));
        const initials = sp.name.split(/\s+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]).join('');
        const avatar = `<span class="avatar" aria-hidden="true">${esc(initials)}${
          sp.photo ? `<img src="${esc(sp.photo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ''
        }</span>`;
        return `<li class="person">${avatar}<div class="person-text">
          <div class="person-name">${sp.url ? `<a href="${esc(sp.url)}" target="_blank" rel="noopener">${esc(sp.name)}</a>` : esc(sp.name)}${mod ? ' <span class="pill next">Moderator</span>' : ''}</div>
          ${sp.title ? `<div class="person-role">${esc(sp.title)}</div>` : ''}
          ${others.map((o) => `<div class="person-more"><button type="button" data-open="${esc(o.id)}">Also: ${esc(dayShort(o.date))} ${o.start} · ${esc(o.title)}</button></div>`).join('')}
        </div></li>`;
      })
      .join('');
    const body = (s.body || []).map((b) => (b.h ? `<h4>${esc(b.h)}</h4>` : `<p>${esc(b.p)}</p>`)).join('');
    const notes = [...(s.separateTicket ? ['Separate ticket'] : []), ...s.notes.filter((x) => !/separate ticket/i.test(x) || !s.separateTicket)];
    const startUtc = romeToUtc(s.date, s.start);
    const endUtc = romeToUtc(s.date, s.end);
    const gcal =
      'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      `&text=${encodeURIComponent(s.title)}` +
      `&dates=${icsStamp(startUtc)}/${icsStamp(endUtc)}` +
      `&location=${encodeURIComponent(`${s.room}, ${address}`)}` +
      `&details=${encodeURIComponent(`${s.typeLabel} at VIEW Conference 2026${s.url ? `\n${s.url}` : ''}`)}`;

    return `<div class="sheet-head">
        <p class="detail-when"><b>${esc(dayShort(s.date))} · ${s.start}–${s.end}</b>${st === 'live' ? ' <span class="pill live">Live</span>' : st === 'past' ? ' · Finished' : ''}</p>
        <button type="button" class="star-btn" data-star="${esc(s.id)}" aria-pressed="${picked}" aria-label="${picked ? 'Remove from' : 'Add to'} My picks">${ICON.star}</button>
        <button type="button" class="icon-btn" data-act="close" aria-label="Close" autofocus>${ICON.close}</button>
      </div>
      <div class="sheet-body">
        <h2 class="detail-title" id="session-title">${esc(s.title)}</h2>
        ${s.lede ? `<p class="detail-lede">${esc(s.lede)}</p>` : ''}
        <dl class="detail-facts">
          <dt>Format</dt><dd>${esc(s.typeLabel)}${s.language ? ` · ${esc(s.language)}` : ''}${s.attendance ? ` · ${esc(s.attendance)}` : ''}</dd>
          <dt>When</dt><dd>${esc(dayLong(s.date))}, ${s.start}–${s.end}</dd>
          <dt>Where</dt><dd><b>${esc(s.room)}</b>${s.venue ? ` · <a href="${MAPS + encodeURIComponent(address)}" target="_blank" rel="noopener">${esc(s.venue)}</a>` : ''}</dd>
          ${s.topics.length ? `<dt>Subjects</dt><dd><span class="tags" style="margin:0">${s.topics.map((k) => `<span class="tag" style="--c:var(--t-${esc(k)})">${esc(topicByKey.get(k)?.label || k)}</span>`).join('')}</span></dd>` : ''}
        </dl>
        ${notes.length ? `<div class="detail-notes">${notes.map((x) => `<span class="note${/ticket/i.test(x) ? ' warn' : ''}">${esc(x)}</span>`).join('')}</div>` : ''}
        ${conflicts.length ? `<div class="conflict">Overlaps with your pick${conflicts.length > 1 ? 's' : ''} ${conflicts.map((o) => `<button type="button" class="linkish" data-open="${esc(o.id)}">“${esc(o.title)}” (${o.start}–${o.end})</button>`).join(', ')}</div>` : ''}
        <div class="actions-row">
          <a class="btn" href="ics/${encodeURIComponent(s.id)}.ics">${ICON.cal}Add to calendar</a>
          <button type="button" class="btn" data-act="share" data-id="${esc(s.id)}">${ICON.share}Share</button>
        </div>
        <p class="small-links">Or add to <a href="${esc(gcal)}" target="_blank" rel="noopener">Google Calendar</a></p>
        ${people.length ? `<h3 class="detail-section">${people.length === 1 ? 'Speaker' : 'Speakers'}</h3><ul class="people">${peopleHtml}</ul>` : ''}
        ${body ? `<h3 class="detail-section">About this session</h3><div class="desc">${body}</div>` : ''}
        ${s.url ? `<p><a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">${ICON.ext}Official session page</a></p>` : ''}
      </div>`;
  }

  function showSession(id, { push = true } = {}) {
    const s = byId.get(id);
    if (!s) return;
    const dlg = $('#session-sheet');
    dlg.innerHTML = sessionSheetHtml(s);
    if (push) {
      if (openSheet === dlg) history.replaceState({ sheet: 'session' }, '', buildUrl(id));
      else history.pushState({ sheet: 'session' }, '', buildUrl(id));
    }
    openDialog(dlg);
    $('.sheet-body', dlg).scrollTop = 0;
  }

  // ---------------------------------------------------------------------------
  // Filter sheet
  // ---------------------------------------------------------------------------
  let speakerQuery = '';
  function filterSheetHtml() {
    return `<div class="sheet-head"><h2 id="filter-title">Filters</h2>
        <button type="button" class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button></div>
      <div class="sheet-body" id="filter-body">
        <section class="f-section"><h3>Subject</h3><div class="f-chips" id="f-topics"></div></section>
        <section class="f-section"><h3>Speaker <small id="f-speaker-count"></small></h3>
          <input class="f-search" id="f-speaker-q" type="search" placeholder="Find a speaker or studio" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Find a speaker or studio">
          <ul class="speaker-list" id="f-speakers"></ul>
        </section>
        <section class="f-section"><h3>Format <small>Light Pass: talks, panels and keynotes</small></h3><div class="f-chips" id="f-types"></div></section>
        <section class="f-section"><h3>Room</h3><div class="f-chips" id="f-rooms"></div></section>
      </div>
      <div class="sheet-foot">
        <button type="button" class="btn" data-act="clear-filters">Clear</button>
        <button type="button" class="btn primary" data-act="close" id="f-show"></button>
      </div>`;
  }

  function updateFilterSheet({ speakers = true } = {}) {
    const dlg = $('#filter-sheet');
    if (!dlg.open) return;
    $('#f-topics', dlg).innerHTML = P.topics
      .map((t) => {
        const on = state.topics.has(t.key);
        const n = facetCount('topics', (s) => s.topics.includes(t.key));
        return chip({ label: t.label, color: t.key, n, pressed: on, disabled: !n && !on, attrs: `data-toggle="topics" data-value="${esc(t.key)}"` });
      })
      .join('');
    $('#f-types', dlg).innerHTML = P.types
      .map((t) => {
        const on = state.types.has(t);
        const n = facetCount('types', (s) => s.type === t);
        return chip({ label: t, n, pressed: on, disabled: !n && !on, attrs: `data-toggle="types" data-value="${esc(t)}"` });
      })
      .join('');
    const roomsByVenue = new Map();
    for (const s of P.sessions) {
      const v = s.venue || 'Other';
      if (!roomsByVenue.has(v)) roomsByVenue.set(v, new Set());
      roomsByVenue.get(v).add(s.room);
    }
    $('#f-rooms', dlg).innerHTML = [...roomsByVenue]
      .map(
        ([venue, rooms]) =>
          `<div class="f-venue">${esc(venue)}</div>` +
          [...rooms]
            .map((r) => {
              const on = state.rooms.has(r);
              const n = facetCount('rooms', (s) => s.room === r);
              return chip({ label: r, n, pressed: on, disabled: !n && !on, attrs: `data-toggle="rooms" data-value="${esc(r)}"` });
            })
            .join(''),
      )
      .join('');
    if (speakers) renderSpeakerList();
    const total = results().length;
    $('#f-show', dlg).textContent = finding() ? `Show ${plural(total, 'session')}` : 'Show all sessions';
    $('#f-speaker-count', dlg).textContent = state.speakers.size ? `${state.speakers.size} selected` : `${P.speakers.length}`;
  }

  function renderSpeakerList() {
    const q = fold(speakerQuery).split(/\s+/).filter(Boolean);
    const list = P.speakers.filter((sp) => {
      if (!q.length) return true;
      const hay = fold(`${sp.name} ${sp.title}`);
      return q.every((t) => hay.includes(t));
    });
    // Selected speakers first so they're easy to untick.
    list.sort((a, b) => state.speakers.has(b.id) - state.speakers.has(a.id));
    $('#f-speakers').innerHTML = list.length
      ? list
          .map((sp) => {
            const n = sp.sessions.filter((id) => byId.has(id)).length;
            return `<li><label><input type="checkbox" data-speaker="${esc(sp.id)}" ${state.speakers.has(sp.id) ? 'checked' : ''}>
              <span class="s-text"><span class="s-name">${highlight(sp.name, q)}</span><span class="s-role" style="display:block">${highlight(sp.title, q)}</span></span>
              <span class="n">${n}</span></label></li>`;
          })
          .join('')
      : `<li class="empty" style="padding:16px 0">No speaker matches “${esc(speakerQuery)}”.</li>`;
  }

  function showFilters() {
    const dlg = $('#filter-sheet');
    speakerQuery = '';
    dlg.innerHTML = filterSheetHtml();
    history.pushState({ sheet: 'filters' }, '', buildUrl());
    openDialog(dlg);
    updateFilterSheet();
  }

  // ---------------------------------------------------------------------------
  // Info sheet
  // ---------------------------------------------------------------------------
  function showInfo() {
    const dlg = $('#info-sheet');
    const venues = (P.venues || [])
      .map((v) => `<div class="venue"><b>${esc(v.when.replace(/\s*Location$/i, ''))}</b><span>${esc(v.where)}</span><br>
        <a href="${MAPS + encodeURIComponent(v.where)}" target="_blank" rel="noopener">Open in Maps</a></div>`)
      .join('');
    dlg.innerHTML = `<div class="sheet-head"><h2 id="info-title">About this program</h2>
        <button type="button" class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button></div>
      <div class="sheet-body info">
        <h3>Venues</h3>${venues}
        <h3>Good to know</h3>
        <ul>${P.notes.map((x) => `<li>${esc(x)}</li>`).join('')}
          <li>All times are Turin local time. The official program labels them CET; Italy is on summer time (CEST, UTC+2) until 25 October.</li></ul>
        <h3>Your picks</h3>
        <p>Starred sessions are saved in this browser on this device only. Nothing is sent anywhere.</p>
        ${countValidPicks() ? `<p><button type="button" class="btn" data-act="export-picks">${ICON.cal}Add all ${countValidPicks()} picks to calendar</button></p>` : ''}
        <h3>Use it offline</h3>
        <p>Once loaded, the program keeps working without a connection. Add it to your home screen for one-tap access: in Safari tap Share, then <i>Add to Home Screen</i>; in Chrome open the menu and tap <i>Add to Home screen</i>.</p>
        <h3>Source</h3>
        <p>Sessions, times and rooms come from the <a href="${esc(P.source.url)}" target="_blank" rel="noopener">official VIEW Conference 2026 program</a>${P.source.updated ? ` (updated ${esc(P.source.updated)})` : ''}, and are re-checked every 20 minutes during the conference. If something here disagrees with signage at the venue, trust the venue.</p>
      </div>`;
    history.pushState({ sheet: 'info' }, '', buildUrl());
    openDialog(dlg);
  }

  // ---------------------------------------------------------------------------
  // Dialog plumbing (Back closes sheets)
  // ---------------------------------------------------------------------------
  function openDialog(dlg) {
    if (openSheet && openSheet !== dlg && openSheet.open) openSheet.close();
    if (!dlg.open) dlg.showModal();
    openSheet = dlg;
    document.documentElement.style.overflow = 'hidden';
  }
  function closeDialogs() {
    for (const d of $$('dialog.sheet')) if (d.open) d.close();
    openSheet = null;
    document.documentElement.style.overflow = '';
  }
  function requestClose() {
    if (history.state && history.state.sheet) history.back();
    else {
      closeDialogs();
      history.replaceState(null, '', buildUrl());
    }
  }

  // History entries are only pushed for open sheets, so Back means "close the
  // sheet" (or step back to the previous session). Filters and search live in
  // `state`, not in history, so write them back into the restored URL.
  window.addEventListener('popstate', () => {
    const id = currentSessionId();
    const open = id && byId.has(id) ? id : null;
    if (open) showSession(open, { push: false });
    else closeDialogs();
    history.replaceState(history.state, '', buildUrl(open));
    render();
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function changed({ keepScroll = false } = {}) {
    syncUrl();
    render();
    updateFilterSheet({ speakers: false });
    if (!keepScroll) scrollToListTop();
  }

  function scrollToListTop() {
    const top = $('#chips-row').getBoundingClientRect().top + window.scrollY - $('#bar').offsetHeight;
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top) });
  }

  function togglePick(id) {
    const s = byId.get(id);
    if (!s) return;
    const had = picks.has(id);
    if (had) picks.delete(id);
    else picks.add(id);
    writeJSON(localStorageSafe(), PICKS_KEY, [...picks]);
    const label = `${had ? 'Add to' : 'Remove from'} My picks: ${s.title}`;
    for (const b of $$(`[data-star="${CSS.escape(id)}"]`)) {
      b.setAttribute('aria-pressed', String(!had));
      if (b.closest('.card')) b.setAttribute('aria-label', label);
    }
    // Re-render so overlap warnings and the My picks view stay right.
    const y = window.scrollY;
    renderChips();
    renderList();
    renderDays();
    window.scrollTo({ top: y });
    if ($('#session-sheet').open && currentSessionId()) {
      const scroll = $('#session-sheet .sheet-body').scrollTop;
      $('#session-sheet').innerHTML = sessionSheetHtml(byId.get(currentSessionId()));
      $('#session-sheet .sheet-body').scrollTop = scroll;
    }
    toast(had ? 'Removed from My picks' : 'Added to My picks', had ? { label: 'Undo', run: () => togglePick(id) } : null);
  }

  async function share(id) {
    const s = byId.get(id);
    const url = new URL(buildUrl(id), location.href);
    url.searchParams.delete('now');
    const data = { title: s.title, text: `${s.title} · ${dayShort(s.date)} ${s.start} · ${s.room}`, url: url.href };
    try {
      if (navigator.share) {
        await navigator.share(data);
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(url.href);
      toast('Link copied');
    } catch {
      prompt('Copy this link', url.href);
    }
  }

  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  }
  function icsFold(line) {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const b = new TextEncoder().encode(ch).length;
      if (bytes + b > 74) {
        out.push(cur);
        cur = ' ';
        bytes = 1;
      }
      cur += ch;
      bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function exportPicks() {
    const sessions = P.sessions.filter((s) => picks.has(s.id));
    if (!sessions.length) return;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//view26//VIEW 2026 program//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:VIEW 2026 picks'];
    for (const s of sessions) {
      const people = s._people.map((p) => `${p.name}${p.title ? ` (${p.title})` : ''}`).join(', ');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${s.id}@view26-program`,
        'DTSTAMP:20261001T000000Z',
        `DTSTART:${icsStamp(romeToUtc(s.date, s.start))}`,
        `DTEND:${icsStamp(romeToUtc(s.date, s.end))}`,
        `SUMMARY:${icsEscape(s.title)}`,
        `LOCATION:${icsEscape(`${s.room}, ${venueAddress(s.venue)}`)}`,
        `DESCRIPTION:${icsEscape(`${s.typeLabel}${people ? ` with ${people}` : ''}${s.url ? `\n${s.url}` : ''}`)}`,
        ...(s.url ? [`URL:${s.url}`] : []),
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.map(icsFold).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'view2026-picks.ics';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  let toastTimer = null;
  function toast(text, action) {
    $$('.toast').forEach((t) => t.remove());
    clearTimeout(toastTimer);
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `${esc(text)}${action ? ` <button type="button" class="toast-act">${esc(action.label)}</button>` : ''}`;
    if (action) $('.toast-act', el).addEventListener('click', () => {
      el.remove();
      action.run();
    });
    // Inside an open modal dialog, only the dialog is interactive.
    (openSheet && openSheet.open ? openSheet : document.body).appendChild(el);
    toastTimer = setTimeout(() => el.remove(), action ? 4000 : 2200);
  }

  function clearAll() {
    state.q = '';
    tokens = [];
    $('#q').value = '';
    clearFilters();
  }
  function clearFilters() {
    state.topics.clear();
    state.types.clear();
    state.rooms.clear();
    state.speakers.clear();
    state.picksOnly = false;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) {
      // Taps on the card body open the session, like the title link.
      const card = e.target.closest('.card');
      if (card && !window.getSelection().toString()) showSession(card.dataset.id);
      return;
    }
    if (t.dataset.open) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      showSession(t.dataset.open);
      return;
    }
    if (t.dataset.star) {
      togglePick(t.dataset.star);
      return;
    }
    if (t.dataset.day) {
      const date = t.dataset.day;
      state.day = date;
      writeJSON(sessionStorageSafe(), DAY_KEY, { day: date, on: now().date });
      if (finding()) {
        const section = document.getElementById(`d-${date}`);
        if (section) section.scrollIntoView({ block: 'start' });
        else toast(`No matches on ${dayShort(date)}`);
        return;
      }
      render();
      window.scrollTo({ top: 0 });
      return;
    }
    if (t.dataset.toggle) {
      const set = state[t.dataset.toggle];
      const v = t.dataset.value;
      if (set.has(v)) set.delete(v);
      else set.add(v);
      changed({ keepScroll: !!t.closest('dialog') });
      return;
    }
    if (t.dataset.remove) {
      state[t.dataset.remove].delete(t.dataset.value);
      changed();
      return;
    }
    switch (t.dataset.act) {
      case 'picks':
        state.picksOnly = !state.picksOnly;
        changed();
        break;
      case 'clear':
        clearAll();
        changed();
        break;
      case 'clear-filters':
        clearFilters();
        changed({ keepScroll: !!t.closest('dialog') });
        if (t.closest('dialog')) updateFilterSheet();
        break;
      case 'clear-q':
        state.q = '';
        tokens = [];
        $('#q').value = '';
        changed();
        break;
      case 'close':
        requestClose();
        break;
      case 'share':
        share(t.dataset.id);
        break;
      case 'export-picks':
        exportPicks();
        break;
    }
  });

  document.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-speaker]');
    if (!box) return;
    if (box.checked) state.speakers.add(box.dataset.speaker);
    else state.speakers.delete(box.dataset.speaker);
    changed({ keepScroll: true });
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'f-speaker-q') {
      speakerQuery = e.target.value;
      renderSpeakerList();
    }
  });

  let searchTimer = null;
  function onSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = $('#q').value;
      if (q === state.q) return;
      state.q = q;
      tokens = fold(q).split(/\s+/).filter(Boolean);
      changed();
    }, 120);
  }

  for (const dlg of $$('dialog.sheet')) {
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      requestClose();
    });
    // A tap on the dimmed backdrop lands on the dialog element itself.
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) requestClose();
    });
    dlg.addEventListener('close', () => {
      if (!$$('dialog.sheet').some((d) => d.open)) {
        openSheet = null;
        document.documentElement.style.overflow = '';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function pickDefaultDay() {
    const n = now();
    const saved = readJSON(sessionStorageSafe(), DAY_KEY, null);
    if (saved && saved.on === n.date && dayOf(saved.day)) return saved.day;
    if (dayOf(n.date)) return n.date;
    return P.days[0].date;
  }

  function renderFooter() {
    const updated = P.source.updated ? ` Last updated by the organisers ${esc(P.source.updated)}.` : '';
    $('#footer').innerHTML = `<p>Program data from the <a href="${esc(P.source.url)}" target="_blank" rel="noopener">official VIEW Conference 2026 program</a>.${updated}</p>
      <p>Times are Turin local time. ${P.notes.map(esc).join(' ')}</p>`;
  }

  function setOffline() {
    const off = navigator.onLine === false;
    $('#masthead-sub').textContent = off ? 'Offline · showing the saved program' : 'Program · Turin, 12–16 Oct · Turin local time';
  }

  function trackBarHeight() {
    const bar = $('#bar');
    const set = () => document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
    set();
    if ('ResizeObserver' in window) new ResizeObserver(set).observe(bar);
  }

  async function loadProgram() {
    const res = await fetch('data/program.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function boot() {
    trackBarHeight();
    setOffline();
    window.addEventListener('online', setOffline);
    window.addEventListener('offline', setOffline);
    try {
      prepare(await loadProgram());
    } catch (err) {
      $('#list').innerHTML = `<div class="empty"><h2>Couldn’t load the program</h2><p>Check your connection and try again.</p>
        <div class="actions"><button type="button" class="btn primary" onclick="location.reload()">Try again</button>
        <a class="btn" href="https://www.viewconference.it/assets/html/view_CET.html">Official program</a></div></div>`;
      return;
    }
    state.day = pickDefaultDay();
    const openId = readUrl();
    $('#q').value = state.q;
    $('#q').addEventListener('input', onSearch);
    $('#q').addEventListener('search', onSearch);
    $('#q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });
    $('#clear-q').addEventListener('click', () => {
      state.q = '';
      tokens = [];
      $('#q').value = '';
      changed();
      $('#q').focus();
    });
    $('#filter-btn').addEventListener('click', showFilters);
    $('#info-btn').addEventListener('click', showInfo);
    $('#now-btn').addEventListener('click', jumpToNow);
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !openSheet && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        $('#q').focus();
      }
    });
    renderFooter();
    render();
    if (openId && byId.has(openId)) {
      // Opened from a shared link: put a plain entry underneath so Back lands on the list.
      history.replaceState(null, '', buildUrl());
      showSession(openId);
    }
    setInterval(tick, 30 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
    });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  boot();
})();
