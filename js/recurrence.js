/* JX Calendar — recurrence engine (Phase 3)
 *
 * Pure functions, no DOM, no Date parsing. All arithmetic uses the civil-date engine
 * (js/dates.js), so daylight saving and UTC never affect results.
 *
 * Rule shape (stored on the master event as `recurrence`):
 *   frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
 *   interval: 1..99
 *   weekdays: [0..6]                                  WEEKLY only (0 = Sunday)
 *   monthlyPattern: { type: 'DAY', day: 1..31 }       MONTHLY only
 *                 | { type: 'ORDINAL', ordinal: 1|2|3|4|-1, weekday: 0..6 }
 *   yearlyPattern: { month: 1..12, day: 1..31 }       YEARLY only
 *   endType: 'NEVER' | 'UNTIL' | 'COUNT'
 *   untilDate: 'YYYY-MM-DD' (inclusive)               UNTIL only
 *   count: 1..999 (first occurrence included)         COUNT only
 *   exceptions: [{ occurrenceId, status: 'CANCELLED' }]
 *   overrides:  [{ occurrenceId, fields: {...changed fields} }]
 *
 * Occurrence identity (occurrenceId) = the occurrence's ORIGINAL scheduled start date. It never
 * changes, even when that occurrence is moved by an override.
 *
 * Policies:
 *  - Occurrences are pattern-matching dates on/after the series start date (the start date
 *    itself appears only if it matches the pattern).
 *  - Weekly intervals count Monday-based weeks from the week of the start date; the user's
 *    Monday/Sunday display preference never affects which dates occur.
 *  - Monthly "day N": months without day N are skipped (no clamping to month end).
 *  - Yearly 29 February: occurs only in leap years.
 *  - Ordinal weekday: 1st–4th or last; these exist in every month.
 */
import { parseDate, formatYMD, toDayNumber, fromDayNumber, addDays, diffDays, weekday, daysInMonth, isValidDate } from './dates.js';

export const FREQUENCIES = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
export const END_TYPES = Object.freeze(['NEVER', 'UNTIL', 'COUNT']);
export const ORDINALS = Object.freeze([1, 2, 3, 4, -1]);
export const RLIMITS = Object.freeze({
  interval: 99,
  count: 999,
  maxInstances: 5000,     // per expansion call
  maxRangeDays: 3700,     // ~10 years per expansion call
  maxEmptyPeriods: 400,   // consecutive periods without an occurrence before giving up
  maxYear: 9999,
});

const isInt = (v) => Number.isInteger(v);

/* ---------- helpers ---------- */
const mondayOf = (n) => n - ((((n + 4) % 7) + 7) % 7 + 6) % 7; // n = day number
const monthIndex = (s) => { const p = parseDate(s); return p.y * 12 + (p.m - 1); };

/** Last date an event occupies (timed event ending 00:00 does not occupy its end date). */
export function lastDateOf(ev) {
  if (!ev.allDay && ev.endTime === '00:00' && ev.endDate > ev.startDate) return addDays(ev.endDate, -1);
  return ev.endDate;
}

export function nthWeekdayOfMonth(y, m, wd, ordinal) {
  const dim = daysInMonth(y, m);
  if (ordinal === -1) {
    const lastWd = weekday(formatYMD(y, m, dim));
    return formatYMD(y, m, dim - ((lastWd - wd + 7) % 7));
  }
  const firstWd = weekday(formatYMD(y, m, 1));
  const d = 1 + ((wd - firstWd + 7) % 7) + 7 * (ordinal - 1);
  return d <= dim ? formatYMD(y, m, d) : null;
}

/** Candidate dates for period k (sorted). Returns null when past the supported year range. */
function candidates(rule, start, k) {
  const a = parseDate(start);
  switch (rule.frequency) {
    case 'DAILY': {
      const n = toDayNumber(start) + k * rule.interval;
      if (n > toDayNumber(`${RLIMITS.maxYear}-12-31`)) return null;
      return [fromDayNumber(n)];
    }
    case 'WEEKLY': {
      const base = mondayOf(toDayNumber(start)) + k * 7 * rule.interval;
      if (base > toDayNumber(`${RLIMITS.maxYear}-12-24`)) return null;
      return rule.weekdays.map((wd) => (wd + 6) % 7).sort((x, y) => x - y).map((off) => fromDayNumber(base + off));
    }
    case 'MONTHLY': {
      const idx = a.y * 12 + (a.m - 1) + k * rule.interval;
      const y = Math.floor(idx / 12); const m = (idx % 12) + 1;
      if (y > RLIMITS.maxYear) return null;
      const p = rule.monthlyPattern;
      const d = p.type === 'DAY'
        ? (p.day <= daysInMonth(y, m) ? formatYMD(y, m, p.day) : null)
        : nthWeekdayOfMonth(y, m, p.weekday, p.ordinal);
      return d ? [d] : [];
    }
    case 'YEARLY': {
      const y = a.y + k * rule.interval;
      if (y > RLIMITS.maxYear) return null;
      const { month, day } = rule.yearlyPattern;
      return day <= daysInMonth(y, month) ? [formatYMD(y, month, day)] : [];
    }
    default: return null;
  }
}

/** Index of the period containing `date` (may be negative). */
function periodIndex(rule, start, date) {
  switch (rule.frequency) {
    case 'DAILY': return Math.floor((toDayNumber(date) - toDayNumber(start)) / rule.interval);
    case 'WEEKLY': return Math.floor((mondayOf(toDayNumber(date)) - mondayOf(toDayNumber(start))) / (7 * rule.interval));
    case 'MONTHLY': return Math.floor((monthIndex(date) - monthIndex(start)) / rule.interval);
    case 'YEARLY': return Math.floor((parseDate(date).y - parseDate(start).y) / rule.interval);
    default: return 0;
  }
}

/**
 * Generator of scheduled occurrence dates (ids) in order, honouring start, UNTIL and COUNT.
 * With `from` (and no COUNT) it jumps straight to the period containing `from`, so opening a
 * distant month never walks the series from its start. COUNT series always start at period 0,
 * which is bounded by count ≤ 999.
 */
export function* scheduledDates(start, rule, from = null) {
  let k = 0;
  if (from && rule.endType !== 'COUNT' && from > start) k = Math.max(0, periodIndex(rule, start, from) - 1);
  let produced = 0; let empty = 0;
  for (;;) {
    const c = candidates(rule, start, k);
    if (c === null) return;
    let hit = false;
    for (const d of c) {
      if (d < start) continue;
      if (rule.endType === 'UNTIL' && d > rule.untilDate) return;
      if (rule.endType === 'COUNT' && produced >= rule.count) return;
      produced++; hit = true;
      yield d;
    }
    if (hit) empty = 0;
    else if (++empty > RLIMITS.maxEmptyPeriods) return;
    k++;
  }
}

/* ---------- validation ---------- */

/**
 * Validate and normalise a rule from user input. Returns { ok, errors, rule }.
 * errors keys: frequency, interval, weekdays, monthly, yearly, until, count, pattern
 */
export function validateRule(input, startDate) {
  const errors = {};
  if (!input || !FREQUENCIES.includes(input.frequency)) return { ok: false, errors: { frequency: 'Choose how often it repeats.' }, rule: null };
  const rule = { frequency: input.frequency };
  const interval = Number(input.interval);
  if (!isInt(interval) || interval < 1 || interval > RLIMITS.interval) errors.interval = `Enter a whole number from 1 to ${RLIMITS.interval}.`;
  rule.interval = interval;

  if (rule.frequency === 'WEEKLY') {
    const wds = Array.isArray(input.weekdays) ? input.weekdays.map(Number) : [];
    if (!wds.length) errors.weekdays = 'Choose at least one day of the week.';
    else if (!wds.every((d) => isInt(d) && d >= 0 && d <= 6) || new Set(wds).size !== wds.length) errors.weekdays = 'Choose valid days of the week.';
    rule.weekdays = [...new Set(wds)].sort((x, y) => x - y);
  }
  if (rule.frequency === 'MONTHLY') {
    const p = input.monthlyPattern || {};
    if (p.type === 'DAY') {
      const day = Number(p.day);
      if (!isInt(day) || day < 1 || day > 31) errors.monthly = 'Enter a day of the month from 1 to 31.';
      rule.monthlyPattern = { type: 'DAY', day };
    } else if (p.type === 'ORDINAL') {
      const ordinal = Number(p.ordinal); const wd = Number(p.weekday);
      if (!ORDINALS.includes(ordinal) || !isInt(wd) || wd < 0 || wd > 6) errors.monthly = 'Choose which weekday of the month.';
      rule.monthlyPattern = { type: 'ORDINAL', ordinal, weekday: wd };
    } else errors.monthly = 'Choose a monthly pattern.';
  }
  if (rule.frequency === 'YEARLY') {
    const p = input.yearlyPattern || {};
    const month = Number(p.month); const day = Number(p.day);
    if (!isInt(month) || month < 1 || month > 12) errors.yearly = 'Choose a month.';
    else if (!isInt(day) || day < 1 || day > daysInMonth(2000, month)) errors.yearly = `Enter a day from 1 to ${daysInMonth(2000, month)}.`;
    rule.yearlyPattern = { month, day };
  }

  const endType = END_TYPES.includes(input.endType) ? input.endType : null;
  if (!endType) errors.until = 'Choose when it stops repeating.';
  rule.endType = endType || 'NEVER';
  if (endType === 'UNTIL') {
    if (!isValidDate(input.untilDate)) errors.until = 'Choose a valid end date.';
    else if (isValidDate(startDate) && input.untilDate < startDate) errors.until = 'The repeat end date can’t be before the start date.';
    rule.untilDate = input.untilDate;
  }
  if (endType === 'COUNT') {
    const count = Number(input.count);
    if (!isInt(count) || count < 1 || count > RLIMITS.count) errors.count = `Enter a number of times from 1 to ${RLIMITS.count}.`;
    rule.count = count;
  }

  if (!Object.keys(errors).length && isValidDate(startDate)) {
    const first = scheduledDates(startDate, rule).next();
    if (first.done) errors.pattern = 'This pattern has no dates after the start date. Check the start date and repeat settings.';
  }
  return { ok: Object.keys(errors).length === 0, errors, rule: Object.keys(errors).length ? null : rule };
}

/** Validate a stored rule including exceptions/overrides shapes. Never mutates. */
export function validateStoredRule(rec) {
  const r = rec && rec.recurrence;
  if (!r || typeof r !== 'object') return false;
  const v = validateRule(r, rec.startDate);
  if (!v.ok) return false;
  const ex = r.exceptions ?? [];
  const ov = r.overrides ?? [];
  if (!Array.isArray(ex) || !Array.isArray(ov)) return false;
  if (!ex.every((e) => e && isValidDate(e.occurrenceId) && e.status === 'CANCELLED')) return false;
  if (!ov.every((o) => o && isValidDate(o.occurrenceId) && o.fields && typeof o.fields === 'object')) return false;
  return true;
}

/* ---------- occurrence queries ---------- */

/** Is `id` an occurrence the rule schedules (ignoring cancellations)? */
export function isScheduled(start, rule, id) {
  if (!isValidDate(id) || id < start) return false;
  if (rule.endType === 'UNTIL' && id > rule.untilDate) return false;
  if (rule.endType === 'COUNT') {
    for (const d of scheduledDates(start, rule)) { if (d === id) return true; if (d > id) return false; }
    return false;
  }
  const k = periodIndex(rule, start, id);
  const c = k >= 0 ? candidates(rule, start, k) : null;
  return !!c && c.includes(id);
}

export const cancelledSet = (rule) => new Set((rule.exceptions || []).filter((e) => e.status === 'CANCELLED').map((e) => e.occurrenceId));
export const overrideMap = (rule) => new Map((rule.overrides || []).map((o) => [o.occurrenceId, o.fields]));
export const isCancelled = (rule, id) => cancelledSet(rule).has(id);

/** Duration of every occurrence: whole-day span plus the master's times. */
export function occurrenceDuration(master) {
  return { days: diffDays(master.startDate, master.endDate), startTime: master.startTime, endTime: master.endTime, allDay: master.allDay };
}

/** Build the occurrence instance for `id`, applying an override's changed fields if any. */
export function makeOccurrence(master, id, overrideFields = null) {
  const span = diffDays(master.startDate, master.endDate);
  const base = {
    title: master.title, description: master.description, category: master.category,
    allDay: master.allDay, startTime: master.startTime, endTime: master.endTime,
    startDate: id, endDate: addDays(id, span),
  };
  const inst = overrideFields ? { ...base, ...overrideFields } : base;
  return { ...inst, id: `${master.id}::${id}`, masterId: master.id, occurrenceId: id, recurring: true, overridden: !!overrideFields, recurrence: master.recurrence };
}

const overlaps = (inst, from, to) => inst.startDate <= to && lastDateOf(inst) >= from;

/**
 * Occurrence instances of a series that overlap [from, to] (inclusive), with cancellations
 * removed and overrides applied (including overrides moved into the range from elsewhere).
 * Returns { items, truncated }.
 */
export function expandSeries(master, from, to) {
  const rule = master.recurrence;
  let truncated = false;
  if (diffDays(from, to) > RLIMITS.maxRangeDays) { to = addDays(from, RLIMITS.maxRangeDays); truncated = true; }
  const span = diffDays(master.startDate, lastDateOf(master));
  const qStart = addDays(from, -Math.max(0, span));
  const cancelled = cancelledSet(rule);
  const overrides = overrideMap(rule);
  const items = [];
  for (const id of scheduledDates(master.startDate, rule, qStart)) {
    if (id > to) break;
    if (id < qStart || cancelled.has(id) || overrides.has(id)) continue;
    const inst = makeOccurrence(master, id);
    if (overlaps(inst, from, to)) items.push(inst);
    if (items.length >= RLIMITS.maxInstances) { truncated = true; break; }
  }
  for (const [id, fields] of overrides) {
    if (cancelled.has(id) || !isScheduled(master.startDate, rule, id)) continue;
    const inst = makeOccurrence(master, id, fields);
    if (overlaps(inst, from, to)) items.push(inst);
  }
  return { items, truncated };
}

/** First scheduled, non-cancelled occurrence id on/after `date`, or null. */
export function nextOccurrence(master, date) {
  const cancelled = cancelledSet(master.recurrence);
  for (const id of scheduledDates(master.startDate, master.recurrence, date)) {
    if (id >= date && !cancelled.has(id)) return id;
  }
  return null;
}

/** Last scheduled, non-cancelled occurrence id strictly before `date`, or null. */
export function previousOccurrence(master, date) {
  const rule = master.recurrence; const start = master.startDate;
  if (date <= start) return null;
  const cancelled = cancelledSet(rule);
  if (rule.endType === 'COUNT') {
    let prev = null;
    for (const id of scheduledDates(start, rule)) { if (id >= date) break; if (!cancelled.has(id)) prev = id; }
    return prev;
  }
  let empty = 0;
  for (let k = periodIndex(rule, start, date); k >= 0; k--) {
    const c = (candidates(rule, start, k) || []).filter((d) => d >= start && d < date && (rule.endType !== 'UNTIL' || d <= rule.untilDate) && !cancelled.has(d));
    if (c.length) return c[c.length - 1];
    if (++empty > RLIMITS.maxEmptyPeriods * 4) return null;
  }
  return null;
}

/** Number of scheduled occurrences (before cancellations). Infinity for never-ending series. */
export function countOccurrences(master, { limit = 100000 } = {}) {
  if (master.recurrence.endType === 'NEVER') return Infinity;
  let n = 0;
  for (const _ of scheduledDates(master.startDate, master.recurrence)) { if (++n >= limit) return n; } // eslint-disable-line no-unused-vars
  return n;
}

/** Exceptions/overrides whose identity is no longer scheduled by `rule` starting at `start`. */
export function invalidExceptionIds(oldRule, start, newRule) {
  const ids = new Set([...(oldRule.exceptions || []).map((e) => e.occurrenceId), ...(oldRule.overrides || []).map((o) => o.occurrenceId)]);
  return [...ids].filter((id) => !newRule || !isScheduled(start, newRule, id)).sort();
}

/** Default pattern fields derived from a start date (used by the form). */
export function defaultsFor(startDate) {
  const p = parseDate(startDate);
  const wd = weekday(startDate);
  const dim = daysInMonth(p.y, p.m);
  const nth = Math.ceil(p.d / 7);
  return {
    weekdays: [wd],
    monthlyDay: p.d,
    ordinal: nth <= 4 ? nth : -1, // a 5th weekday can only be expressed as "last"
    ordinalWeekday: wd,
    yearlyMonth: p.m,
    yearlyDay: p.d,
  };
}
