/* JX Calendar — view renderers (Today, Month, Day, Agenda). Pure HTML builders. */
import {
  monthGrid, weekdayOrder, weekdayShort, weekdayNarrow, formatMonthYear, formatLong, formatDayMonth,
  formatWeekdayName, formatShortNoYear, formatDayMonthYear, weekdayLong, formatYMD, formatTime, parseDate, addDays, diffDays, weekday,
} from './dates.js';
import { categoryLabel, lastDate, isMultiDay } from './events.js';

/* ---------- Plain-language recurrence summary ---------- */
const ORD_WORD = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
function listJoin(a) { return a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`; }
export function describeRecurrence(rule) {
  if (!rule) return '';
  const n = rule.interval;
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[rule.frequency];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (rule.frequency === 'WEEKLY') {
    const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => rule.weekdays.includes(d));
    s += ` on ${listJoin(order.map(weekdayLong))}`;
  } else if (rule.frequency === 'MONTHLY') {
    const p = rule.monthlyPattern;
    s += p.type === 'DAY' ? ` on day ${p.day}${p.day >= 29 ? ' (skips months without it)' : ''}`
      : ` on the ${ORD_WORD[p.ordinal]} ${weekdayLong(p.weekday)}`;
  } else if (rule.frequency === 'YEARLY') {
    const { month, day } = rule.yearlyPattern;
    s += ` on ${formatDayMonth(formatYMD(2000, month, day))}${month === 2 && day === 29 ? ' (leap years only)' : ''}`;
  }
  if (rule.endType === 'UNTIL') s += `, until ${formatDayMonthYear(rule.untilDate)}`;
  if (rule.endType === 'COUNT') s += rule.count === 1 ? ', once' : `, ${rule.count} times`;
  return s;
}
import { esc, icon } from './ui.js';

const MAX_CELL_ITEMS = 3;
export const AGENDA_PAGE = 40;

/* ---------- Shared pieces ---------- */
function segmentMeta(seg) {
  const { ev, date, part } = seg;
  const span = isMultiDay(ev) ? diffDays(ev.startDate, lastDate(ev)) + 1 : 1;
  const dayN = diffDays(ev.startDate, date) + 1;
  const dayOf = span > 1 ? ` · Day ${dayN} of ${span}` : '';
  if (ev.allDay) return `All day${dayOf}`;
  if (part === 'single') return `${formatTime(ev.startTime)} – ${formatTime(ev.endTime)}`;
  if (part === 'start') return `From ${formatTime(ev.startTime)}${dayOf}`;
  if (part === 'end') return `Until ${formatTime(ev.endTime)}${dayOf}`;
  return `All day${dayOf}`;
}

export function whenText(ev) {
  const last = lastDate(ev);
  if (ev.allDay) {
    return last === ev.startDate ? `${formatLong(ev.startDate)} · All day`
      : `${formatShortNoYear(ev.startDate)} – ${formatShortNoYear(ev.endDate)} ${parseDate(ev.endDate).y} · All day`;
  }
  if (ev.startDate === ev.endDate) return `${formatLong(ev.startDate)} · ${formatTime(ev.startTime)} – ${formatTime(ev.endTime)}`;
  return `${formatShortNoYear(ev.startDate)}, ${formatTime(ev.startTime)} – ${formatShortNoYear(ev.endDate)} ${parseDate(ev.endDate).y}, ${formatTime(ev.endTime)}`;
}

function eventCard(ev, meta, { compact = false } = {}) {
  return `<li><button type="button" class="ev-card cat-${esc(ev.category)}${compact ? ' is-compact' : ''}" data-event-id="${esc(ev.id)}">
    <span class="ev-bar" aria-hidden="true"></span>
    <span class="ev-main"><span class="ev-title">${esc(ev.title)}</span><span class="ev-meta">${ev.recurring ? `${icon('repeat', 'icon icon-xs')}<span class="sr-only">Repeating event. </span>` : ''}${esc(meta)}</span></span>
    <span class="ev-cat">${esc(categoryLabel(ev.category))}</span>
  </button></li>`;
}

function emptyState({ title, text, date, cta = 'Add an event', glyph = 'calendar' }) {
  return `<div class="empty">
    <span class="empty-glyph">${icon(glyph, 'icon icon-lg')}</span>
    <p class="empty-title">${esc(title)}</p>
    ${text ? `<p class="empty-text">${esc(text)}</p>` : ''}
    ${date ? `<button type="button" class="btn btn-secondary" data-act="add" data-date="${date}">${icon('plus')}${esc(cta)}</button>` : ''}
  </div>`;
}

function dayList(segments) {
  const all = segments.filter((s) => s.kind === 'allday');
  const timed = segments.filter((s) => s.kind === 'timed');
  let html = '';
  if (all.length) html += `<h3 class="list-label">All day</h3><ul class="ev-list">${all.map((s) => eventCard(s.ev, segmentMeta(s))).join('')}</ul>`;
  if (timed.length) html += `<h3 class="list-label">Schedule</h3><ul class="ev-list">${timed.map((s) => eventCard(s.ev, segmentMeta(s))).join('')}</ul>`;
  return html;
}

export function modeTabs(mode) {
  const tab = (m, label, href) => `<a class="tab" href="${href}" ${mode === m ? 'aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="tabs" aria-label="Calendar views">
    ${tab('month', 'Month', '#/calendar/month')}${tab('day', 'Day', '#/calendar/day')}${tab('agenda', 'Agenda', '#/calendar/agenda')}
  </nav>`;
}

/* ---------- Today ---------- */
function greeting(now) {
  const h = now.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function renderToday(store, today, now = new Date()) {
  const segs = store.onDate(today);
  const horizonEnd = addDays(today, 14);
  const upcoming = store.agenda(addDays(today, 1), { horizonDays: 13 }).items.filter((it) => it.date <= horizonEnd).slice(0, 6);
  const count = segs.length;

  const todayList = count
    ? dayList(segs)
    : emptyState({ title: 'Nothing scheduled today', text: 'Enjoy the open day, or plan something new.', glyph: 'sun' });

  const upcomingList = upcoming.length
    ? `<ul class="ev-list">${upcoming.map((it) => eventCard(it.ev,
        `${formatShortNoYear(it.date)} · ${it.ev.allDay ? 'All day' : it.ongoing ? 'Continues' : `${formatTime(it.ev.startTime)} – ${formatTime(it.ev.endTime)}`}`,
        { compact: true })).join('')}</ul>
       <a class="link-btn" href="#/calendar/agenda">See all upcoming ${icon('chevron-right')}</a>`
    : `<p class="muted-line">Nothing in the next two weeks.</p>`;

  return `<div class="today">
    <section class="hero" aria-labelledby="today-heading">
      <div class="hero-text">
        <p class="eyebrow">${greeting(now)}</p>
        <h1 class="hero-date" id="today-heading">${esc(formatWeekdayName(today))}, ${esc(formatDayMonth(today))}</h1>
        <p class="hero-sub">${parseDate(today).y} · ${count === 0 ? 'No events today' : count === 1 ? '1 event today' : `${count} events today`}</p>
      </div>
      <div class="hero-actions">
        <button type="button" class="btn btn-gold btn-lg" data-act="add" data-date="${today}">${icon('plus')}Add event</button>
        <button type="button" class="btn btn-hero btn-lg" data-act="add-task">${icon('check-circle')}Add task</button>
      </div>
    </section>
    <div class="today-grid">
      <section class="card" aria-labelledby="today-list-h">
        <h2 class="card-title" id="today-list-h">Today</h2>
        ${todayList}
      </section>
      <section class="card" aria-labelledby="upcoming-h">
        <h2 class="card-title" id="upcoming-h">Coming up</h2>
        ${upcomingList}
      </section>
    </div>
  </div>`;
}

/* ---------- Month ---------- */
export function renderMonth(store, { selected, today, weekStart }) {
  const { y, m } = parseDate(selected);
  const dates = monthGrid(y, m, weekStart);
  const index = store.indexRange(dates[0], dates[dates.length - 1]);
  const order = weekdayOrder(weekStart);
  const monthPrefix = selected.slice(0, 7);

  const head = order.map((d) => `<div class="wd" role="columnheader"><abbr title="${esc(weekdayShort(d))}"><span class="wd-short">${esc(weekdayShort(d))}</span><span class="wd-narrow" aria-hidden="true">${esc(weekdayNarrow(d))}</span></abbr></div>`).join('');

  let rows = '';
  for (let r = 0; r < dates.length / 7; r++) {
    let cells = '';
    for (let c = 0; c < 7; c++) {
      const date = dates[r * 7 + c];
      const segs = index.get(date) || [];
      const inMonth = date.startsWith(monthPrefix);
      const isToday = date === today; const isSel = date === selected;
      const d = Number(date.slice(8));
      const items = segs.slice(0, MAX_CELL_ITEMS).map((s) =>
        `<span class="chip cat-${esc(s.ev.category)} part-${s.part}"><span class="chip-text">${esc(s.ev.title)}</span></span>`).join('');
      const more = segs.length > MAX_CELL_ITEMS ? `<span class="chip-more">+${segs.length - MAX_CELL_ITEMS}</span>` : '';
      const label = `${formatLong(date)}${isToday ? ', today' : ''}${segs.length ? `, ${segs.length} event${segs.length > 1 ? 's' : ''}` : ', no events'}`;
      cells += `<div role="gridcell" class="cell${inMonth ? '' : ' is-outside'}${isToday ? ' is-today' : ''}${isSel ? ' is-selected' : ''}${segs.length ? ' has-events' : ''}" aria-selected="${isSel}">
        <button type="button" class="day-btn" data-date="${date}" tabindex="${isSel ? 0 : -1}" aria-label="${esc(label)}"${isToday ? ' aria-current="date"' : ''}>
          <span class="day-num">${d}</span>
          <span class="day-items" aria-hidden="true">${items}${more}</span>
        </button>
      </div>`;
    }
    rows += `<div class="grid-row" role="row">${cells}</div>`;
  }

  const segs = index.get(selected) || store.onDate(selected);
  const panelList = segs.length ? dayList(segs) : emptyState({ title: 'No events', text: 'This day is free.', date: selected, cta: 'Add event' });

  return `<div class="month-layout">
    <section class="month-card" aria-labelledby="month-title">
      <div class="month-head">
        <h2 class="month-title" id="month-title" aria-live="polite">${esc(formatMonthYear(y, m))}</h2>
        <div class="nav-cluster">
          <button type="button" class="icon-btn" data-act="prev-month" aria-label="Previous month">${icon('chevron-left')}</button>
          <button type="button" class="btn btn-pill" data-act="today">Today</button>
          <button type="button" class="icon-btn" data-act="next-month" aria-label="Next month">${icon('chevron-right')}</button>
        </div>
      </div>
      <div class="grid" role="grid" aria-labelledby="month-title" data-rows="${dates.length / 7}">
        <div class="grid-row grid-head" role="row">${head}</div>
        ${rows}
      </div>
      <p class="grid-hint">Use arrow keys to move between days. Press Enter to open the day.</p>
    </section>
    <aside class="card day-panel" aria-labelledby="panel-title">
      <div class="panel-head">
        <div>
          <p class="eyebrow">${esc(formatWeekdayName(selected))}${selected === today ? ' · Today' : ''}</p>
          <h2 class="panel-title" id="panel-title">${esc(formatDayMonthYear(selected))}</h2>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-act="add" data-date="${selected}">${icon('plus')}Add</button>
      </div>
      ${panelList}
      <a class="link-btn" href="#/calendar/day/${selected}">Open day view ${icon('chevron-right')}</a>
    </aside>
  </div>`;
}

/* ---------- Day ---------- */
export function renderDay(store, { selected, today }) {
  const segs = store.onDate(selected);
  const body = segs.length ? dayList(segs)
    : emptyState({ title: 'Nothing scheduled', text: `${formatWeekdayName(selected)} is free.`, date: selected, cta: 'Add event' });
  return `<div class="day-view">
    <section class="card day-head" aria-labelledby="day-title">
      <button type="button" class="icon-btn" data-act="prev-day" aria-label="Previous day">${icon('chevron-left')}</button>
      <div class="day-head-text">
        <p class="eyebrow">${esc(formatWeekdayName(selected))}${selected === today ? ' · Today' : ''}</p>
        <h2 class="day-title" id="day-title" aria-live="polite">${esc(formatDayMonthYear(selected))}</h2>
      </div>
      <button type="button" class="icon-btn" data-act="next-day" aria-label="Next day">${icon('chevron-right')}</button>
    </section>
    <div class="action-row">
      <button type="button" class="btn btn-pill" data-act="today"${selected === today ? ' disabled' : ''}>Today</button>
      <button type="button" class="btn btn-primary" data-act="add" data-date="${selected}">${icon('plus')}Add event</button>
    </div>
    <section class="card day-body" aria-label="Events">${body}</section>
  </div>`;
}

/* ---------- Agenda ---------- */
export function renderAgenda(store, { today, limit }) {
  const { items, horizon, hasSeries } = store.agenda(today);
  const horizonNote = hasSeries ? `<p class="agenda-note">${icon('repeat', 'icon icon-xs')}Repeating events are listed up to ${esc(formatDayMonthYear(horizon))}.</p>` : '';
  if (!items.length) {
    return `<section class="card">${emptyState({ title: 'No upcoming events', text: 'Events you add from today onward will be listed here.', date: today, cta: 'Add an event', glyph: 'list' })}</section>`;
  }
  const shown = items.slice(0, limit);
  let html = ''; let current = null;
  for (const it of shown) {
    if (it.date !== current) {
      if (current !== null) html += '</ul></li>';
      current = it.date;
      const rel = it.date === today ? 'Today' : it.date === addDays(today, 1) ? 'Tomorrow' : formatWeekdayName(it.date);
      html += `<li class="ag-group"><h3 class="ag-date"><span class="ag-rel">${esc(rel)}</span><span class="ag-full">${esc(formatDayMonthYear(it.date))}</span></h3><ul class="ev-list">`;
    }
    const ev = it.ev;
    let meta;
    if (ev.allDay) meta = isMultiDay(ev) ? `All day · until ${formatShortNoYear(lastDate(ev))}` : 'All day';
    else if (it.ongoing) meta = `Continues · until ${formatShortNoYear(ev.endDate)}, ${formatTime(ev.endTime)}`;
    else meta = ev.startDate === ev.endDate ? `${formatTime(ev.startTime)} – ${formatTime(ev.endTime)}`
      : `${formatTime(ev.startTime)} – ${formatShortNoYear(ev.endDate)}, ${formatTime(ev.endTime)}`;
    if (it.ongoing && ev.allDay) meta = `Continues · until ${formatShortNoYear(lastDate(ev))}`;
    html += eventCard(ev, meta);
  }
  html += '</ul></li>';
  const more = items.length > limit
    ? `<button type="button" class="btn btn-secondary btn-block" data-act="agenda-more">Show more (${items.length - limit} remaining)</button>` : '';
  return `<section class="card agenda" aria-labelledby="agenda-h">
    <div class="panel-head">
      <div><p class="eyebrow">From today</p><h2 class="panel-title" id="agenda-h">Upcoming · ${items.length} event${items.length === 1 ? '' : 's'}</h2></div>
      <button type="button" class="btn btn-primary btn-sm" data-act="add" data-date="${today}">${icon('plus')}Add</button>
    </div>
    <ul class="ag-list">${html}</ul>
    ${more}
    ${horizonNote}
  </section>`;
}

export { weekday };
