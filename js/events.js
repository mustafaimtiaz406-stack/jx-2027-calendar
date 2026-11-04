/* JX Calendar — event model, validation, in-memory store and day queries (Phase 2)
 *
 * Record shape (events store, schema v1 — no migration needed):
 *   id, title, description, startDate, endDate, startTime, endTime, allDay, category,
 *   createdAt, updatedAt
 * Technical fields:
 *   start  — sort key 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'; feeds the existing v1 `by_start` index
 *   tz     — IANA zone where the event was last saved (informational; not used for display)
 *   v      — record format version (1)
 *
 * Phase 3: an optional `recurrence` object turns a record into a recurring series master
 * (see js/recurrence.js). Records with recurrence carry v: 2; one-time records keep v: 1.
 * Occurrence instances are generated, never stored; their id is `${masterId}::${occurrenceId}`.
 *
 * Time-zone strategy: "floating" local wall-clock time. Dates are 'YYYY-MM-DD' strings and
 * times are 'HH:MM' strings, shown exactly as entered on any device; nothing passes through
 * UTC, so daylight-saving changes cannot shift an event.
 */
import { getAll, put, remove } from './db.js';
import { isValidDate, normalizeTime, timeToMinutes, addDays, diffDays, toDayNumber, fromDayNumber } from './dates.js';
import {
  validateRule, validateStoredRule, expandSeries, makeOccurrence, isScheduled, cancelledSet, overrideMap, invalidExceptionIds,
} from './recurrence.js';

export const CATEGORIES = Object.freeze([
  { id: 'personal', label: 'Personal' },
  { id: 'family', label: 'Family' },
  { id: 'work', label: 'Work' },
  { id: 'important', label: 'Important' },
  { id: 'other', label: 'Other' },
]);
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
export const categoryLabel = (id) => (CATEGORIES.find((c) => c.id === id) || CATEGORIES[4]).label;

export const LIMITS = Object.freeze({ title: 120, description: 4000 });

/**
 * Validate raw form input. Returns { ok, errors: {field: message}, value } where value is the
 * normalised event fields (without id/timestamps).
 */
export function validateEvent(input) {
  const errors = {};
  const title = String(input.title ?? '').trim();
  const description = String(input.description ?? '').replace(/\s+$/, '');
  const allDay = input.allDay === true;
  const startDate = String(input.startDate ?? '');
  const endDate = String(input.endDate ?? '');
  const category = String(input.category ?? '');

  if (!title) errors.title = 'Enter a title for the event.';
  else if (title.length > LIMITS.title) errors.title = `Keep the title under ${LIMITS.title} characters.`;
  if (description.length > LIMITS.description) errors.description = `Keep the description under ${LIMITS.description} characters.`;

  const startOk = isValidDate(startDate);
  const endOk = isValidDate(endDate);
  if (!startOk) errors.startDate = 'Choose a valid start date.';
  if (!endOk) errors.endDate = 'Choose a valid end date.';
  if (startOk && endOk && endDate < startDate) errors.endDate = 'The end date can’t be before the start date.';

  let startTime = null; let endTime = null;
  if (!allDay) {
    startTime = normalizeTime(input.startTime ?? '');
    endTime = normalizeTime(input.endTime ?? '');
    if (!startTime) errors.startTime = 'Choose a valid start time.';
    if (!endTime) errors.endTime = 'Choose a valid end time.';
    if (startTime && endTime && startOk && endOk && startDate === endDate &&
        timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      errors.endTime = 'The end time must be after the start time.';
    }
  }

  if (!CATEGORY_IDS.has(category)) errors.category = 'Choose a category.';

  const ok = Object.keys(errors).length === 0;
  return {
    ok, errors,
    value: ok ? { title, description, startDate, endDate, startTime, endTime, allDay, category } : null,
  };
}

/** Last calendar date the event actually occupies (a timed event ending 00:00 doesn't touch that day). */
export function lastDate(ev) {
  if (!ev.allDay && ev.endTime === '00:00' && ev.endDate > ev.startDate) return addDays(ev.endDate, -1);
  return ev.endDate;
}

export const isMultiDay = (ev) => lastDate(ev) > ev.startDate;

function isStoredEventUsable(ev) {
  if (!ev || typeof ev.id !== 'string' || ev.id.includes('::')) return false;
  if (!validateEvent(ev).ok) return false;
  return ev.recurrence == null || validateStoredRule(ev);
}

export const isSeries = (rec) => !!(rec && rec.recurrence);
export const parseInstanceKey = (key) => {
  const i = String(key).indexOf('::');
  return i < 0 ? { masterId: key, occurrenceId: null } : { masterId: key.slice(0, i), occurrenceId: key.slice(i + 2) };
};

const TIME_KEYS = ['startDate', 'endDate', 'startTime', 'endTime', 'allDay'];
const TEXT_KEYS = ['title', 'description', 'category'];

export class ImpactError extends Error {
  constructor(impact) { super('Series change needs confirmation'); this.impact = impact; }
}

const newId = () => (globalThis.crypto && crypto.randomUUID
  ? crypto.randomUUID()
  : `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/**
 * Per-day "segment" describing how an event appears on one date.
 * kind: 'allday' | 'timed'; part: 'single' | 'start' | 'middle' | 'end'
 */
function segmentFor(ev, date) {
  const last = lastDate(ev);
  const multi = last > ev.startDate;
  const part = !multi ? 'single' : date === ev.startDate ? 'start' : date === last ? 'end' : 'middle';
  if (ev.allDay) return { ev, date, kind: 'allday', part, sort: -1 };
  if (!multi) return { ev, date, kind: 'timed', part, sort: timeToMinutes(ev.startTime), sortEnd: timeToMinutes(ev.endTime) };
  if (part === 'start') return { ev, date, kind: 'timed', part, sort: timeToMinutes(ev.startTime), sortEnd: 1440 };
  if (part === 'end') return { ev, date, kind: 'timed', part, sort: 0, sortEnd: timeToMinutes(ev.endTime) };
  return { ev, date, kind: 'allday', part, sort: -1 };
}

function compareSegments(a, b) {
  if (a.kind !== b.kind) return a.kind === 'allday' ? -1 : 1;
  if (a.kind === 'allday') {
    // longer spans first, then title
    const la = diffDays(a.ev.startDate, lastDate(a.ev)); const lb = diffDays(b.ev.startDate, lastDate(b.ev));
    if (la !== lb) return lb - la;
  } else {
    if (a.sort !== b.sort) return a.sort - b.sort;
    if (a.sortEnd !== b.sortEnd) return a.sortEnd - b.sortEnd;
  }
  return a.ev.title.localeCompare(b.ev.title) || a.ev.id.localeCompare(b.ev.id);
}

export class EventStore {
  constructor(db) {
    this.db = db;
    this.events = new Map();   // stored records: one-time events and recurring series masters
    this.skipped = 0;          // stored records that fail validation (kept in DB, not shown)
    this.truncated = false;    // last expansion hit a safety limit
    this.listeners = new Set();
  }

  async load() {
    this.events.clear();
    this.skipped = 0;
    if (!this.db) return;
    const rows = await getAll(this.db, 'events');
    for (const ev of rows) {
      if (isStoredEventUsable(ev)) this.events.set(ev.id, ev);
      else this.skipped++;
    }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(change) { for (const fn of this.listeners) fn(change); }

  /** Stored record by id (one-time event or series master). */
  get(id) { return this.events.get(id) || null; }
  all() { return Array.from(this.events.values()); }
  get size() { return this.events.size; }

  /** Display instance by key: a one-time record, or a generated occurrence ('master::YYYY-MM-DD'). */
  getInstance(key) {
    const { masterId, occurrenceId } = parseInstanceKey(key);
    const rec = this.events.get(masterId);
    if (!rec) return null;
    if (!occurrenceId) return isSeries(rec) ? null : rec;
    if (!isSeries(rec)) return null;
    const rule = rec.recurrence;
    if (!isScheduled(rec.startDate, rule, occurrenceId) || cancelledSet(rule).has(occurrenceId)) return null;
    return makeOccurrence(rec, occurrenceId, overrideMap(rule).get(occurrenceId) || null);
  }

  /** Commit a record to IndexedDB, then (only on success) to memory. */
  async commit(record, change) {
    await put(this.db, 'events', record);
    this.events.set(record.id, record);
    this.emit({ ...change, event: record });
    return record;
  }

  /**
   * What a series edit would do to existing changed/cancelled dates.
   * { invalid: [occurrenceIds no longer in the schedule], stopsRepeating, kept }
   */
  seriesChangeImpact(id, { startDate, recurrence }) {
    const rec = this.events.get(id);
    if (!isSeries(rec)) return { invalid: [], stopsRepeating: false, kept: 0 };
    let rule = null;
    if (recurrence) { const v = validateRule(recurrence, startDate); rule = v.ok ? v.rule : null; }
    const invalid = invalidExceptionIds(rec.recurrence, startDate, rule);
    const total = new Set([...(rec.recurrence.exceptions || []), ...(rec.recurrence.overrides || [])].map((x) => x.occurrenceId)).size;
    return { invalid, stopsRepeating: !recurrence, kept: total - invalid.length };
  }

  /**
   * Validate and save a one-time event or a whole series (create when no id).
   * input.recurrence: rule input or null. Editing a series keeps every change/cancellation whose
   * original date is still in the schedule; dropping any (or stopping the repeat) requires
   * { confirmedImpact: true }, otherwise an ImpactError is thrown and nothing is written.
   */
  async save(input, { confirmedImpact = false } = {}) {
    if (!this.db) throw new Error('Storage is unavailable, so the event can’t be saved.');
    const result = validateEvent(input);
    const errors = { ...result.errors };
    let rule = null;
    if (input.recurrence) {
      const r = validateRule(input.recurrence, input.startDate);
      if (r.ok) rule = r.rule; else Object.assign(errors, r.errors);
    }
    if (Object.keys(errors).length) { const e = new Error('Invalid event'); e.validation = errors; throw e; }

    const existing = input.id ? this.events.get(input.id) : null;
    if (input.id && !existing) throw new Error('That event no longer exists.');
    const v = result.value;
    if (isSeries(existing)) {
      const impact = this.seriesChangeImpact(existing.id, { startDate: v.startDate, recurrence: rule });
      if ((impact.invalid.length || impact.stopsRepeating) && !confirmedImpact) throw new ImpactError(impact);
      if (rule) {
        const keep = (x) => !impact.invalid.includes(x.occurrenceId);
        const ex = (existing.recurrence.exceptions || []).filter(keep);
        const ov = (existing.recurrence.overrides || []).filter(keep);
        if (ex.length) rule.exceptions = ex;
        if (ov.length) rule.overrides = ov;
      }
    }

    const now = new Date().toISOString();
    let tz = null;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) { /* optional */ }
    const record = {
      ...(existing || {}),            // keep any unknown fields from future versions
      ...v,
      id: existing ? existing.id : newId(),
      start: v.allDay ? v.startDate : `${v.startDate}T${v.startTime}`,
      tz,
      v: rule ? 2 : 1,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    if (rule) record.recurrence = rule; else delete record.recurrence;
    return this.commit(record, { type: existing ? 'update' : 'create' });
  }

  /**
   * "This event only": store the differences between the edited occurrence and its scheduled
   * version as an override keyed by the ORIGINAL date. Date/time fields are stored as a group
   * so the override is always self-consistent. Returns the updated instance.
   */
  async saveOccurrence(key, input) {
    if (!this.db) throw new Error('Storage is unavailable.');
    const { masterId, occurrenceId } = parseInstanceKey(key);
    const master = this.events.get(masterId);
    if (!isSeries(master) || !this.getInstance(key)) throw new Error('That event no longer exists.');
    const result = validateEvent(input);
    if (!result.ok) { const e = new Error('Invalid event'); e.validation = result.errors; throw e; }
    const v = result.value;
    const base = makeOccurrence(master, occurrenceId, null);
    const fields = {};
    if (TIME_KEYS.some((k) => v[k] !== base[k])) TIME_KEYS.forEach((k) => { fields[k] = v[k]; });
    TEXT_KEYS.forEach((k) => { if (v[k] !== base[k]) fields[k] = v[k]; });
    const overrides = (master.recurrence.overrides || []).filter((o) => o.occurrenceId !== occurrenceId);
    if (Object.keys(fields).length) overrides.push({ occurrenceId, fields });
    const recurrence = { ...master.recurrence };
    if (overrides.length) recurrence.overrides = overrides; else delete recurrence.overrides;
    const record = { ...master, recurrence, updatedAt: new Date().toISOString() };
    await this.commit(record, { type: 'update' });
    return makeOccurrence(record, occurrenceId, Object.keys(fields).length ? fields : null);
  }

  /** "Delete this event only": cancellation exception keyed by the original date. */
  async cancelOccurrence(key) {
    if (!this.db) throw new Error('Storage is unavailable.');
    const { masterId, occurrenceId } = parseInstanceKey(key);
    const master = this.events.get(masterId);
    if (!isSeries(master) || !this.getInstance(key)) throw new Error('That event no longer exists.');
    const recurrence = { ...master.recurrence };
    recurrence.exceptions = [...(recurrence.exceptions || []).filter((e) => e.occurrenceId !== occurrenceId), { occurrenceId, status: 'CANCELLED' }];
    const overrides = (recurrence.overrides || []).filter((o) => o.occurrenceId !== occurrenceId);
    if (overrides.length) recurrence.overrides = overrides; else delete recurrence.overrides;
    const record = { ...master, recurrence, updatedAt: new Date().toISOString() };
    return this.commit(record, { type: 'update' });
  }

  /** Delete a one-time event or a whole series (its changes/cancellations live inside it). */
  async delete(id) {
    if (!this.db) throw new Error('Storage is unavailable.');
    const masterId = parseInstanceKey(id).masterId;
    const ev = this.events.get(masterId);
    await remove(this.db, 'events', masterId);
    this.events.delete(masterId);
    this.emit({ type: 'delete', event: ev });
  }

  /** Every display instance (one-time events and generated occurrences) overlapping [from, to]. */
  instancesInRange(from, to) {
    const out = [];
    this.truncated = false;
    for (const ev of this.events.values()) {
      if (isSeries(ev)) {
        const r = expandSeries(ev, from, to);
        if (r.truncated) this.truncated = true;
        out.push(...r.items);
      } else if (ev.startDate <= to && lastDate(ev) >= from) out.push(ev);
    }
    return out;
  }

  /** Map date → sorted segments for every date in [from, to] (inclusive). */
  indexRange(from, to) {
    const map = new Map();
    const a = toDayNumber(from); const b = toDayNumber(to);
    for (const ev of this.instancesInRange(from, to)) {
      const s = Math.max(a, toDayNumber(ev.startDate));
      const e = Math.min(b, toDayNumber(lastDate(ev)));
      for (let n = s; n <= e; n++) {
        const date = fromDayNumber(n);
        if (!map.has(date)) map.set(date, []);
        map.get(date).push(segmentFor(ev, date));
      }
    }
    for (const list of map.values()) list.sort(compareSegments);
    return map;
  }

  onDate(date) { return this.indexRange(date, date).get(date) || []; }

  /**
   * Upcoming items, each listed once under max(startDate, fromDate), chronologically.
   * One-time events: all upcoming. Repeating events: occurrences within `horizonDays`.
   */
  agenda(fromDate, { horizonDays = 365 } = {}) {
    const horizon = addDays(fromDate, horizonDays);
    const items = [];
    const push = (ev) => items.push({ ev, date: ev.startDate < fromDate ? fromDate : ev.startDate, ongoing: ev.startDate < fromDate });
    for (const ev of this.events.values()) {
      if (isSeries(ev)) expandSeries(ev, fromDate, horizon).items.forEach(push);
      else if (lastDate(ev) >= fromDate) push(ev);
    }
    // Within a date: all-day first, then events continuing from earlier days, then by start time.
    const rank = (it) => (it.ev.allDay ? 0 : it.ongoing ? 1 : 2);
    items.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)
      || rank(x) - rank(y)
      || (rank(x) === 2 ? x.ev.startTime.localeCompare(y.ev.startTime) : 0)
      || x.ev.title.localeCompare(y.ev.title) || x.ev.id.localeCompare(y.ev.id));
    return { items, horizon, hasSeries: this.all().some(isSeries) };
  }
}
