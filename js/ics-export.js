/* JX Calendar — RFC 5545 (iCalendar) export (Phase 5)
 *
 * Read-only: builds an .ics text from stored event records; never writes or modifies data.
 *
 * Mapping decisions (see README "ICS export"):
 *  - Timed events → floating local DATE-TIME (no "Z", no TZID): DTSTART:20270115T090000
 *  - All-day events → VALUE=DATE; DTEND is the day AFTER the inclusive JX end date
 *  - Series → one master VEVENT with RRULE; DTSTART = the series' FIRST ACTUAL occurrence
 *    (RFC 5545 always treats DTSTART as an instance; JX only counts dates matching the pattern)
 *  - WEEKLY rules carry WKST=MO, matching the JX engine's Monday-based week counting
 *  - UNTIL: DATE for all-day series; floating local DATE-TIME (end of that day) for timed series
 *  - Cancelled occurrences → EXDATE (same value type as DTSTART), one per line
 *  - Changed occurrences → extra VEVENT with the same UID and RECURRENCE-ID = ORIGINAL date
 *  - UID = SHA-256 of the internal record id → stable across exports, no internal id exposed
 */
import { getAll } from './db.js';
import { addDays } from './dates.js';
import { validateEvent } from './events.js';
import { validateStoredRule, scheduledDates, isScheduled, makeOccurrence } from './recurrence.js';

export const ICS_MIME = 'text/calendar;charset=utf-8';
export const PRODID = '-//JX//JX Calendar//EN';
const CRLF = '\r\n';
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const UID_DOMAIN = 'jx-calendar.invalid'; // RFC 2606 reserved name: never a real internet domain

/* ---------------- text ---------------- */

/** RFC 5545 §3.3.11 TEXT escaping. Backslash first so nothing is double-escaped. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();
const utf8Len = (s) => encoder.encode(s).length;

/**
 * RFC 5545 §3.1 folding: lines ≤ 75 octets (excluding CRLF); continuation lines start with one
 * space. Splits only between Unicode code points, so a multibyte character is never broken.
 */
export function foldLine(line) {
  if (utf8Len(line) <= 75) return line;
  const parts = [];
  let current = ''; let bytes = 0; let limit = 75;
  for (const ch of line) { // iterates by code point (surrogate pairs kept together)
    const n = utf8Len(ch);
    if (bytes + n > limit) {
      parts.push(current);
      current = ''; bytes = 0; limit = 74; // the leading space takes one octet
    }
    current += ch; bytes += n;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/* ---------------- dates (pure string formatting — no Date parsing, no UTC conversion) ---------------- */
export const icsDate = (ymd) => ymd.replace(/-/g, '');
export const icsFloating = (ymd, hhmm) => `${icsDate(ymd)}T${hhmm.replace(':', '')}00`;
export function icsUtc(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
}

/** DTSTART/DTEND/RECURRENCE-ID/EXDATE property for a date (+ optional time). */
function dtProp(name, ymd, allDay, hhmm) {
  return allDay ? `${name};VALUE=DATE:${icsDate(ymd)}` : `${name}:${icsFloating(ymd, hhmm)}`;
}
/** DTEND: all-day uses the exclusive next day (JX stores the inclusive last day). */
function dtEnd(ev) {
  return ev.allDay ? `DTEND;VALUE=DATE:${icsDate(addDays(ev.endDate, 1))}` : `DTEND:${icsFloating(ev.endDate, ev.endTime)}`;
}

/* ---------------- identifiers ---------------- */
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
/** Deterministic, collision-resistant UID derived from the stored record id (128 bits of SHA-256). */
export async function uidFor(recordId) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(`jx-calendar-event:${recordId}`));
  return `${hex(digest).slice(0, 32)}@${UID_DOMAIN}`;
}

/* ---------------- recurrence ---------------- */
/** RRULE value for a validated JX rule. `allDay`/`startTime` decide the UNTIL value type. */
export function rruleFor(rule, { allDay }) {
  const parts = [`FREQ=${rule.frequency}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.frequency === 'WEEKLY') {
    const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => rule.weekdays.includes(d));
    parts.push(`BYDAY=${order.map((d) => BYDAY[d]).join(',')}`);
    parts.push('WKST=MO');
  }
  if (rule.frequency === 'MONTHLY') {
    const p = rule.monthlyPattern;
    parts.push(p.type === 'DAY' ? `BYMONTHDAY=${p.day}` : `BYDAY=${p.ordinal}${BYDAY[p.weekday]}`);
  }
  if (rule.frequency === 'YEARLY') parts.push(`BYMONTH=${rule.yearlyPattern.month}`, `BYMONTHDAY=${rule.yearlyPattern.day}`);
  if (rule.endType === 'COUNT') parts.push(`COUNT=${rule.count}`);
  // UNTIL is inclusive of the whole JX end date: DATE for all-day, floating end-of-day for timed.
  if (rule.endType === 'UNTIL') parts.push(`UNTIL=${allDay ? icsDate(rule.untilDate) : `${icsDate(rule.untilDate)}T235959`}`);
  return parts.join(';');
}

/* ---------------- validation ---------------- */
export function validateForExport(rec) {
  if (!rec || typeof rec.id !== 'string' || !rec.id || rec.id.includes('::')) return { ok: false, reason: 'missing or invalid identifier' };
  if (!validateEvent(rec).ok) return { ok: false, reason: 'invalid event fields' };
  if (rec.recurrence != null && !validateStoredRule(rec)) return { ok: false, reason: 'invalid repeat rule' };
  return { ok: true };
}

/* ---------------- calendar assembly ---------------- */
function textProps(ev) {
  const lines = [`SUMMARY:${escapeText(ev.title)}`];
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  return lines;
}

/**
 * Build the iCalendar text from stored event records.
 * Returns { text|null, summary } — text is null when there is nothing valid to export.
 */
export async function buildCalendar(records, { now = new Date() } = {}) {
  const summary = { oneTime: 0, series: 0, modified: 0, cancelled: 0, skipped: 0, skippedReasons: [], staleIgnored: 0, separateOccurrences: 0, vevents: 0 };
  const dtstamp = `DTSTAMP:${icsUtc(now)}`;
  const valid = [];
  for (const rec of records) {
    const v = validateForExport(rec);
    if (v.ok) valid.push(rec); else { summary.skipped++; summary.skippedReasons.push(v.reason); }
  }
  // Deterministic order: same data → same file (apart from DTSTAMP)
  valid.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0) || a.id.localeCompare(b.id));
  if (!valid.length) return { text: null, summary };

  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const push = (lines) => { out.push(...lines); summary.vevents++; };
  const lastMod = (rec) => { const u = icsUtc(rec.updatedAt); return u ? [`LAST-MODIFIED:${u}`] : []; };

  for (const rec of valid) {
    const uid = await uidFor(rec.id);
    if (!rec.recurrence) {
      summary.oneTime++;
      push(['BEGIN:VEVENT', `UID:${uid}`, dtstamp, dtProp('DTSTART', rec.startDate, rec.allDay, rec.startTime), dtEnd(rec), ...textProps(rec), ...lastMod(rec), 'END:VEVENT']);
      continue;
    }

    const rule = rec.recurrence;
    const first = scheduledDates(rec.startDate, rule).next().value; // first ACTUAL occurrence
    const firstInst = makeOccurrence(rec, first, null);
    const scheduled = (id) => isScheduled(rec.startDate, rule, id);
    const cancelled = [...new Set((rule.exceptions || []).filter((e) => e.status === 'CANCELLED').map((e) => e.occurrenceId))].sort();
    const exdates = [];
    for (const id of cancelled) { if (scheduled(id)) exdates.push(id); else summary.staleIgnored++; }
    const overrides = [];
    const separate = [];
    for (const o of rule.overrides || []) {
      if (!scheduled(o.occurrenceId) || cancelled.includes(o.occurrenceId)) { summary.staleIgnored++; continue; }
      const inst = makeOccurrence(rec, o.occurrenceId, o.fields);
      if (!validateEvent(inst).ok) { summary.staleIgnored++; continue; }
      // RFC 5545: RECURRENCE-ID must use the same value type as the series DTSTART, so an occurrence
      // switched between all-day and timed can't be an in-series exception. It is exported as its own
      // event and the original date is excluded — reported in the summary, never silently dropped.
      if (inst.allDay !== rec.allDay) separate.push(inst); else overrides.push(inst);
    }

    summary.series++;
    summary.cancelled += exdates.length;
    const master = ['BEGIN:VEVENT', `UID:${uid}`, dtstamp,
      dtProp('DTSTART', firstInst.startDate, rec.allDay, rec.startTime), dtEnd(firstInst),
      `RRULE:${rruleFor(rule, rec)}`];
    for (const id of [...exdates, ...separate.map((s) => s.occurrenceId)].sort()) master.push(dtProp('EXDATE', id, rec.allDay, rec.startTime));
    master.push(...textProps(rec), ...lastMod(rec), 'END:VEVENT');
    push(master);

    for (const inst of overrides.sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId))) {
      summary.modified++;
      push(['BEGIN:VEVENT', `UID:${uid}`, dtstamp,
        dtProp('RECURRENCE-ID', inst.occurrenceId, rec.allDay, rec.startTime),
        dtProp('DTSTART', inst.startDate, inst.allDay, inst.startTime), dtEnd(inst),
        ...textProps(inst), ...lastMod(rec), 'END:VEVENT']);
    }
    for (const inst of separate) {
      summary.modified++; summary.separateOccurrences++;
      push(['BEGIN:VEVENT', `UID:${await uidFor(`${rec.id}::${inst.occurrenceId}`)}`, dtstamp,
        dtProp('DTSTART', inst.startDate, inst.allDay, inst.startTime), dtEnd(inst),
        ...textProps(inst), ...lastMod(rec), 'END:VEVENT']);
    }
  }
  out.push('END:VCALENDAR');
  return { text: out.map(foldLine).join(CRLF) + CRLF, summary };
}

/** Read every stored event (read-only transaction) and build the calendar. */
export async function exportFromDb(db, opts) {
  const records = await getAll(db, 'events');
  return buildCalendar(records, opts);
}

export const exportFilename = (todayYmd) => `JX-Calendar-${todayYmd}.ics`;

/** Trigger a download of `text` as an .ics file (user-initiated). */
export function downloadIcs(text, filename) {
  const blob = new Blob([text], { type: ICS_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener'; a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000); // one-off release once the download has started
}
