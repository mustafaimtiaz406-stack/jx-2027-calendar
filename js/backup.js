/* JX Calendar — Backup & Restore engine (Phase 6)
 *
 * Backup file (JSON, UTF-8) — format "jx-calendar-backup", formatVersion 1:
 *   { format, formatVersion, appVersion, schemaVersion, createdAt,
 *     counts: { events, tasks, settings },
 *     summary: { oneTimeEvents, recurringSeries, cancelledOccurrences, modifiedOccurrences, activeTasks, completedTasks },
 *     data: { events: [...], tasks: [...], settings: [...] },     // the stored records, unchanged
 *     integrity: { algorithm: "SHA-256", scope: "canonical-json", digest: "<hex>" } }
 *
 * Integrity: SHA-256 over the UTF-8 bytes of canonicalJson(payload), where payload is the whole
 * object WITHOUT the "integrity" member, and canonicalJson = JSON with object keys sorted
 * (recursively), no whitespace, arrays in order. It detects accidental damage only — it is not a
 * signature and does not prove who made the file.
 *
 * Restore = full replacement of events, tasks and settings in ONE IndexedDB transaction
 * (db.replaceStores). The meta store (schema history, install record) is never touched.
 */
import { readStores, replaceStores, SCHEMA_VERSION } from './db.js';
import { validateEvent } from './events.js';
import { validateStoredRule, isScheduled, makeOccurrence } from './recurrence.js';
import { readStoredTask } from './tasks.js';
import { isValid as isValidSetting } from './settings.js';

export const BACKUP_FORMAT = 'jx-calendar-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const STORES = Object.freeze(['events', 'tasks', 'settings']);
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // ~25 MB ≈ 25,000+ events with notes; far above realistic use
export const SETTING_KEYS = Object.freeze(['theme', 'weekStart']);
export const JSON_MIME = 'application/json';

/* Older backup formats → current, in memory. None exist yet (v1 is the first format). */
const FORMAT_UPGRADES = Object.freeze({
  // 1: (b) => ({ ...b, formatVersion: 2, ... })   — add here when formatVersion 2 ships
});
/* Older database schema layouts → current, in memory. None exist yet (schema v1 is the first). */
const SCHEMA_UPGRADES = Object.freeze({});

export class BackupError extends Error {
  constructor(code, message, details = []) { super(message); this.name = 'BackupError'; this.code = code; this.details = details; }
}

/* ---------------- canonical form & checksum ---------------- */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
const hasSubtle = () => !!(globalThis.crypto && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === 'function');
export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
const payloadOf = (backup) => { const { integrity, ...rest } = backup; void integrity; return rest; };

/* ---------------- summaries ---------------- */
export function summarize(data) {
  const s = { oneTimeEvents: 0, recurringSeries: 0, cancelledOccurrences: 0, modifiedOccurrences: 0, activeTasks: 0, completedTasks: 0 };
  for (const e of data.events) {
    if (e.recurrence) {
      s.recurringSeries++;
      s.cancelledOccurrences += (e.recurrence.exceptions || []).filter((x) => x.status === 'CANCELLED').length;
      s.modifiedOccurrences += (e.recurrence.overrides || []).length;
    } else s.oneTimeEvents++;
  }
  for (const t of data.tasks) { if ((t.status ?? 'ACTIVE') === 'COMPLETED') s.completedTasks++; else s.activeTasks++; }
  return s;
}

/* ---------------- record validation (shared by backup and restore) ---------------- */
function eventProblem(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'is not a valid record';
  if (typeof e.id !== 'string' || !e.id) return 'has no identifier';
  if (e.id.includes('::')) return 'is a changed date without its repeating series';
  if (!validateEvent(e).ok) return 'has invalid dates, times, title or category';
  if (e.recurrence != null) {
    if (!validateStoredRule(e)) return 'has an invalid repeat rule or invalid changed/cancelled dates';
    const ex = (e.recurrence.exceptions || []).map((x) => x.occurrenceId);
    const ov = (e.recurrence.overrides || []).map((x) => x.occurrenceId);
    if (new Set(ex).size !== ex.length || new Set(ov).size !== ov.length) return 'lists the same changed or cancelled date twice';
    if (ex.some((id) => ov.includes(id))) return 'has a date that is both cancelled and changed';
    for (const o of e.recurrence.overrides || []) {
      for (const k of Object.keys(o.fields)) if (!['title', 'description', 'category', 'startDate', 'endDate', 'startTime', 'endTime', 'allDay'].includes(k)) return 'has a changed date with unknown fields';
      if (!validateEvent(makeOccurrence(e, o.occurrenceId, o.fields)).ok) return 'has a changed date with invalid values';
    }
  } else if ('exceptions' in e || 'overrides' in e) return 'has changed/cancelled dates but no repeat rule';
  return null;
}
function taskProblem(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'is not a valid record';
  if (typeof t.id !== 'string' || !t.id) return 'has no identifier';
  if (!readStoredTask(t)) return 'has an invalid title, status, priority or due date';
  if (t.completedAt != null && typeof t.completedAt !== 'string') return 'has an invalid completion time';
  return null;
}
function settingProblem(s) {
  if (!s || typeof s !== 'object' || typeof s.key !== 'string') return 'is not a valid setting';
  if (!SETTING_KEYS.includes(s.key)) return `“${s.key}” is not a JX setting`;
  if (!isValidSetting(s.key, s.value)) return `has an invalid value for ${s.key}`;
  return null;
}
const label = (kind, rec, i) => {
  const t = rec && typeof rec.title === 'string' && rec.title ? `“${rec.title.slice(0, 40)}”` : `#${i + 1}`;
  return kind === 'setting' ? `Setting ${rec && rec.key ? `“${rec.key}”` : `#${i + 1}`}` : `${kind} ${t}`;
};

/* ---------------- backup ---------------- */
/** Build the backup object from raw store contents (pure apart from hashing). */
export async function buildBackup(raw, { appVersion, schemaVersion = SCHEMA_VERSION, now = new Date() }) {
  const excluded = { events: 0, tasks: 0, settings: 0 };
  const keep = (list, problem, kind) => list.filter((r) => { const ok = !problem(r); if (!ok) excluded[kind]++; return ok; });
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const data = {
    events: keep(raw.events, eventProblem, 'events').sort(byId),
    tasks: keep(raw.tasks, taskProblem, 'tasks').sort(byId),
    settings: keep(raw.settings, settingProblem, 'settings').sort((a, b) => a.key.localeCompare(b.key)),
  };
  const backup = {
    format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, appVersion, schemaVersion,
    createdAt: now.toISOString(),
    counts: { events: data.events.length, tasks: data.tasks.length, settings: data.settings.length },
    summary: summarize(data),
    data,
  };
  let integrityAvailable = false;
  if (hasSubtle()) {
    backup.integrity = { algorithm: 'SHA-256', scope: 'canonical-json', digest: await sha256Hex(canonicalJson(backup)) };
    integrityAvailable = true;
  }
  return { backup, excluded, integrityAvailable };
}

/** Read events, tasks and settings in ONE read-only transaction and build the backup + JSON text. */
export async function createBackup(db, opts) {
  if (!db) throw new BackupError('STORAGE', 'Storage isn’t available, so a backup can’t be made.');
  const raw = await readStores(db, STORES); // resolves after the transaction completes
  const result = await buildBackup(raw, opts);
  const json = JSON.stringify(result.backup, null, 2);
  JSON.parse(json); // serialization sanity check — throws rather than download a broken file
  return { ...result, json };
}

export const backupFilename = (todayYmd) => `JX-Calendar-Backup-${todayYmd}.json`;

export function downloadJson(text, filename) {
  const blob = new Blob([text], { type: JSON_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener'; a.hidden = true;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------------- restore: read & validate (never touches the database) ---------------- */
/** Read a File/Blob as strict UTF-8 text. */
export async function readBackupFile(file) {
  if (!file) throw new BackupError('NO_FILE', 'Choose a backup file first.');
  if (file.size === 0) throw new BackupError('EMPTY', 'This file is empty.');
  if (file.size > MAX_FILE_BYTES) throw new BackupError('TOO_LARGE', `This file is too large to be a JX backup (over ${Math.round(MAX_FILE_BYTES / 1048576)} MB).`);
  let buf;
  try { buf = await file.arrayBuffer(); } catch (e) { throw new BackupError('UNREADABLE', 'This file couldn’t be read. Try choosing it again.'); }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch (_) { throw new BackupError('ENCODING', 'This file isn’t a JX Calendar backup (it isn’t readable text).'); }
}

/**
 * Parse and fully validate a backup text. Returns { backup, preview, notes } or throws BackupError.
 * Steps: JSON → structure → version/schema compatibility → counts → integrity → records.
 */
export async function validateBackupText(text, { schemaVersion = SCHEMA_VERSION } = {}) {
  let b;
  try { b = JSON.parse(text); } catch (_) { throw new BackupError('INVALID_JSON', 'This file isn’t a JX Calendar backup (it isn’t valid backup data).'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BackupError('NOT_BACKUP', 'This file isn’t a JX Calendar backup.');
  if (b.format !== BACKUP_FORMAT) throw new BackupError('WRONG_FORMAT', 'This file isn’t a JX Calendar backup.');
  if (!Number.isInteger(b.formatVersion) || b.formatVersion < 1) throw new BackupError('BAD_VERSION', 'This backup file is damaged (its version is missing).');
  if (b.formatVersion > BACKUP_FORMAT_VERSION) throw new BackupError('NEWER_FORMAT', 'This backup was made by a newer version of JX Calendar. Update the app, then try again.');
  if (!Number.isInteger(b.schemaVersion) || b.schemaVersion < 1) throw new BackupError('BAD_SCHEMA', 'This backup file is damaged (its data version is missing).');
  if (b.schemaVersion > schemaVersion) throw new BackupError('NEWER_SCHEMA', 'This backup uses a newer data layout than this version of JX Calendar supports. Update the app, then try again.');
  if (typeof b.createdAt !== 'string' || Number.isNaN(Date.parse(b.createdAt))) throw new BackupError('BAD_STRUCTURE', 'This backup file is damaged (its creation date is missing).');
  if (!b.data || typeof b.data !== 'object' || STORES.some((s) => !Array.isArray(b.data[s]))) throw new BackupError('BAD_STRUCTURE', 'This backup file is damaged (some of its data sections are missing).');
  if (!b.counts || STORES.some((s) => b.counts[s] !== b.data[s].length)) throw new BackupError('BAD_COUNTS', 'This backup file is damaged (its record counts don’t match its contents).');

  // integrity — verified on the file exactly as read, before any transformation
  const notes = [];
  if (b.integrity != null) {
    if (b.integrity.algorithm !== 'SHA-256' || b.integrity.scope !== 'canonical-json' || typeof b.integrity.digest !== 'string') {
      throw new BackupError('BAD_INTEGRITY', 'This backup file is damaged (its checksum is unreadable).');
    }
    if (!hasSubtle()) throw new BackupError('NO_CRYPTO', 'This browser can’t verify the backup’s checksum, so it can’t be restored safely here.');
    const digest = await sha256Hex(canonicalJson(payloadOf(b)));
    if (digest !== b.integrity.digest) throw new BackupError('CHECKSUM', 'This backup file is damaged: its contents don’t match its checksum. Nothing was changed.');
  } else {
    notes.push('This backup has no checksum, so accidental damage to the file can’t be detected.');
  }

  // in-memory upgrades of older formats / schema layouts (none exist yet)
  let cur = b;
  for (let v = cur.formatVersion; v < BACKUP_FORMAT_VERSION; v++) {
    if (!FORMAT_UPGRADES[v]) throw new BackupError('OLD_FORMAT', 'This backup format is no longer supported.');
    cur = FORMAT_UPGRADES[v](cur);
  }
  for (let v = cur.schemaVersion; v < schemaVersion; v++) {
    if (!SCHEMA_UPGRADES[v]) throw new BackupError('OLD_SCHEMA', 'This backup’s data layout is no longer supported.');
    cur = SCHEMA_UPGRADES[v](cur);
  }

  // record-level (semantic) validation
  const problems = [];
  const check = (list, problem, kind, keyOf) => {
    const seen = new Set();
    list.forEach((r, i) => {
      const p = problem(r);
      if (p) { problems.push(`${label(kind, r, i)} ${p}.`); return; }
      const k = keyOf(r);
      if (seen.has(k)) problems.push(`${label(kind, r, i)} appears more than once.`);
      seen.add(k);
    });
  };
  check(cur.data.events, eventProblem, 'Event', (r) => r.id);
  check(cur.data.tasks, taskProblem, 'Task', (r) => r.id);
  check(cur.data.settings, settingProblem, 'setting', (r) => r.key);
  if (problems.length) throw new BackupError('INVALID_RECORDS', `This backup has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`} and can’t be restored.`, problems);

  // changed/cancelled dates that are no longer on their schedule are harmless (the app ignores them)
  let stale = 0;
  for (const e of cur.data.events) {
    if (!e.recurrence) continue;
    for (const x of [...(e.recurrence.exceptions || []), ...(e.recurrence.overrides || [])]) if (!isScheduled(e.startDate, e.recurrence, x.occurrenceId)) stale++;
  }
  if (stale) notes.push(`${stale} saved change${stale > 1 ? 's' : ''} to repeating events no longer match${stale > 1 ? '' : 'es'} the schedule; ${stale > 1 ? 'they are' : 'it is'} kept but not shown, as before.`);

  const settings = Object.fromEntries(cur.data.settings.map((s) => [s.key, s.value]));
  const preview = {
    createdAt: cur.createdAt, appVersion: typeof b.appVersion === 'string' ? b.appVersion : 'unknown',
    formatVersion: b.formatVersion, schemaVersion: b.schemaVersion, checksum: b.integrity ? 'verified' : 'none',
    ...summarize(cur.data), settings,
    counts: { events: cur.data.events.length, tasks: cur.data.tasks.length, settings: cur.data.settings.length },
  };
  return { backup: cur, preview, notes };
}

/* ---------------- restore: atomic replace + verification ---------------- */
const sortKey = (s) => (s === 'settings' ? 'key' : 'id');
const canonicalStores = (data) => Object.fromEntries(STORES.map((s) => [s, [...data[s]].sort((a, b) => (a[sortKey(s)] < b[sortKey(s)] ? -1 : a[sortKey(s)] > b[sortKey(s)] ? 1 : 0))]));

/**
 * Replace events, tasks and settings with the validated backup in ONE transaction, then read
 * everything back and compare. Throws BackupError('RESTORE_FAILED') if the transaction aborts —
 * in which case IndexedDB has rolled back and the previous data is intact.
 */
export async function restoreBackup(db, validated) {
  if (!db) throw new BackupError('STORAGE', 'Storage isn’t available, so the backup can’t be restored.');
  const data = validated.backup.data;
  try {
    await replaceStores(db, { events: data.events, tasks: data.tasks, settings: data.settings });
  } catch (err) {
    throw new BackupError('RESTORE_FAILED', 'The restore couldn’t be completed. Your existing data has not been changed.', [String(err && err.message || err)]);
  }
  const after = await readStores(db, STORES);
  const expected = canonicalJson(canonicalStores(data));
  const actual = canonicalJson(canonicalStores(after));
  const verified = expected === actual;
  return { verified, counts: { events: after.events.length, tasks: after.tasks.length, settings: after.settings.length } };
}
