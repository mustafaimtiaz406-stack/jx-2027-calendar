/* JX 2027 Calendar — settings persistence
 * Settings are stored one record per key in the `settings` store: { key, value, updatedAt }.
 * Unknown or invalid stored values are ignored (defaults used) but never deleted.
 */
import { get, getAll, put } from './db.js';

export const DEFAULTS = Object.freeze({
  theme: 'system',     // 'system' | 'light' | 'dark'
  weekStart: 'monday', // 'monday' | 'sunday'
});

const VALID = {
  theme: (v) => v === 'system' || v === 'light' || v === 'dark',
  weekStart: (v) => v === 'monday' || v === 'sunday',
};

export function isValid(key, value) {
  return Object.prototype.hasOwnProperty.call(VALID, key) && VALID[key](value);
}

/** Load settings; with no db (storage failure) returns defaults. */
export async function loadSettings(db) {
  const result = { ...DEFAULTS };
  if (!db) return result;
  const rows = await getAll(db, 'settings');
  for (const row of rows) {
    if (row && isValid(row.key, row.value)) result[row.key] = row.value;
  }
  return result;
}

export async function saveSetting(db, key, value) {
  if (!isValid(key, value)) throw new TypeError(`Invalid setting ${key}=${value}`);
  if (!db) return false; // caller shows "not saved" state
  await put(db, 'settings', { key, value, updatedAt: new Date().toISOString() });
  return true;
}

/**
 * Locale's usual first day of the week, mapped to the two supported options.
 * Uses Intl.Locale week info where the browser provides it (getWeekInfo() or weekInfo).
 * CLDR firstDay: 1 = Monday … 7 = Sunday. Saturday-first locales (6) map to Sunday, the
 * nearest supported option. Returns { value, source: 'locale' | 'fallback' }.
 */
export function detectWeekStart(locale = (globalThis.navigator && navigator.language) || undefined) {
  try {
    const loc = new Intl.Locale(locale || Intl.DateTimeFormat().resolvedOptions().locale);
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    const first = info && info.firstDay;
    if (first === 1) return { value: 'monday', source: 'locale' };
    if (first === 7 || first === 6) return { value: 'sunday', source: 'locale' };
  } catch (_) { /* fall through */ }
  return { value: DEFAULTS.weekStart, source: 'fallback' };
}

/**
 * Called on every launch, after markLaunch(). Never overwrites a stored preference.
 *  - Stored valid value      → used as-is.
 *  - Nothing stored, genuine first launch → locale value detected and saved once.
 *  - Nothing stored, existing install (e.g. upgraded from 0.1.0, where the Monday default was
 *    shown but only saved if the user clicked another option) → the previously shown default
 *    is saved, so an upgrade never silently changes the user's calendar layout.
 */
export async function ensureWeekStart(db, { firstLaunch = false } = {}) {
  if (!db) return detectWeekStart().value;
  const existing = await get(db, 'settings', 'weekStart');
  if (existing && isValid('weekStart', existing.value)) return existing.value;
  if (existing) return DEFAULTS.weekStart; // invalid stored value: leave it untouched, use default
  const { value, source } = firstLaunch ? detectWeekStart() : { value: DEFAULTS.weekStart, source: 'previous-default' };
  await put(db, 'settings', { key: 'weekStart', value, source, updatedAt: new Date().toISOString() });
  return value;
}

/** Records first launch once; returns { firstLaunch: boolean, firstLaunchAt }. */
export async function markLaunch(db) {
  if (!db) return { firstLaunch: true, firstLaunchAt: null };
  const existing = await get(db, 'meta', 'install');
  if (existing) return { firstLaunch: false, firstLaunchAt: existing.firstLaunchAt };
  const record = { key: 'install', firstLaunchAt: new Date().toISOString() };
  await put(db, 'meta', record);
  return { firstLaunch: true, firstLaunchAt: record.firstLaunchAt };
}
