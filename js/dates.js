/* JX Calendar — civil date engine
 *
 * All calendar arithmetic works on plain 'YYYY-MM-DD' strings converted to integer
 * day numbers (days since 1970-01-01) with Howard Hinnant's civil-date algorithms.
 * No Date parsing, no UTC conversion, no time zone — so a daylight-saving change can
 * never move a date. The only Date use is reading "today" from the device clock's
 * local fields, and Intl formatting of fixed UTC instants for display names.
 */

const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/;

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatYMD(y, m, d) {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Strictly parse 'YYYY-MM-DD'. Returns {y,m,d} or null (rejects 2027-02-30 etc). */
export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const match = RE_DATE.exec(s);
  if (!match) return null;
  const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export const isValidDate = (s) => parseDate(s) !== null;

/** Normalise 'HH:MM' or 'HH:MM:SS' (native inputs may add seconds) to 'HH:MM'; null if invalid. */
export function normalizeTime(s) {
  if (typeof s !== 'string' || !RE_TIME.test(s)) return null;
  return s.slice(0, 5);
}

export function timeToMinutes(t) {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

export function minutesToTime(min) {
  const m = Math.max(0, Math.min(23 * 60 + 59, min));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

export function toDayNumber(s) {
  const p = parseDate(s);
  if (!p) throw new RangeError(`Invalid date: ${s}`);
  return daysFromCivil(p.y, p.m, p.d);
}

export function fromDayNumber(n) {
  const { y, m, d } = civilFromDays(n);
  return formatYMD(y, m, d);
}

export const addDays = (s, n) => fromDayNumber(toDayNumber(s) + n);
export const diffDays = (a, b) => toDayNumber(b) - toDayNumber(a);

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday (4). */
export function weekday(s) {
  return (((toDayNumber(s) + 4) % 7) + 7) % 7;
}

export function addMonths(y, m, delta) {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (((idx % 12) + 12) % 12) + 1 };
}

/** Same day-of-month in another month, clamped to that month's length. */
export function shiftMonthKeepDay(s, delta) {
  const p = parseDate(s);
  const t = addMonths(p.y, p.m, delta);
  return formatYMD(t.y, t.m, Math.min(p.d, daysInMonth(t.y, t.m)));
}

export function todayLocal(now = new Date()) {
  return formatYMD(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/**
 * Dates shown in a month grid: whole weeks from the week containing the 1st to the week
 * containing the last day. weekStart: 'monday' | 'sunday'. Returns 28–42 date strings.
 */
export function monthGrid(y, m, weekStart) {
  const first = formatYMD(y, m, 1);
  const startDow = weekStart === 'sunday' ? 0 : 1;
  const offset = (weekday(first) - startDow + 7) % 7;
  const cells = Math.ceil((offset + daysInMonth(y, m)) / 7) * 7;
  const start = toDayNumber(first) - offset;
  const out = new Array(cells);
  for (let i = 0; i < cells; i++) out[i] = fromDayNumber(start + i);
  return out;
}

export function weekdayOrder(weekStart) {
  return weekStart === 'sunday' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
}

/* ---------- Display formatting (English UI; order and clock style follow the device locale) ---------- */
const UI_LOCALE = (() => {
  const lang = (globalThis.navigator && navigator.language) || 'en-GB';
  return /^en\b/i.test(lang) ? lang : 'en-GB';
})();
const TIME_LOCALE = (globalThis.navigator && navigator.language) || 'en-GB';

const fmtCache = new Map();
function fmt(key, opts, locale = UI_LOCALE) {
  if (!fmtCache.has(key)) {
    try { fmtCache.set(key, new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts })); }
    catch (_) { fmtCache.set(key, new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts })); }
  }
  return fmtCache.get(key);
}
const utcNoon = (s) => { const p = parseDate(s); return new Date(Date.UTC(p.y, p.m - 1, p.d, 12)); };

export const formatMonthYear = (y, m) => fmt('my', { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 15, 12)));
export const formatLong = (s) => fmt('long', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(utcNoon(s));
export const formatDayMonth = (s) => fmt('dm', { day: 'numeric', month: 'long' }).format(utcNoon(s));
export const formatDayMonthYear = (s) => fmt('dmy', { day: 'numeric', month: 'long', year: 'numeric' }).format(utcNoon(s));
export const formatShort = (s) => fmt('short', { day: 'numeric', month: 'short', year: 'numeric' }).format(utcNoon(s));
export const formatShortNoYear = (s) => fmt('shortny', { weekday: 'short', day: 'numeric', month: 'short' }).format(utcNoon(s));
export const formatWeekdayName = (s) => fmt('wd', { weekday: 'long' }).format(utcNoon(s));
export const weekdayShort = (dow) => fmt('wds', { weekday: 'short' }).format(new Date(Date.UTC(2027, 0, 3 + dow, 12))); // 2027-01-03 is a Sunday
export const weekdayNarrow = (dow) => fmt('wdn', { weekday: 'narrow' }).format(new Date(Date.UTC(2027, 0, 3 + dow, 12)));
export const weekdayLong = (dow) => fmt('wdl', { weekday: 'long' }).format(new Date(Date.UTC(2027, 0, 3 + dow, 12)));
export const monthName = (m) => fmt('mn', { month: 'long' }).format(new Date(Date.UTC(2000, m - 1, 15, 12)));
export function formatTime(t) {
  const min = timeToMinutes(t);
  return fmt('time', { hour: 'numeric', minute: '2-digit' }, TIME_LOCALE)
    .format(new Date(Date.UTC(2000, 0, 1, Math.floor(min / 60), min % 60)));
}
