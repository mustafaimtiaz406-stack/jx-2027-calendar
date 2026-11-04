/* JX Calendar — task model, validation, ordering and in-memory store (Phase 4)
 *
 * Record (tasks store, schema v1 — no migration needed):
 *   id, title, description, dueDate ('YYYY-MM-DD' | null), priority ('LOW'|'MEDIUM'|'HIGH'),
 *   status ('ACTIVE'|'COMPLETED'), createdAt, updatedAt, completedAt (ISO timestamp | null)
 * Technical fields:
 *   due — copy of dueDate, present only when a due date is set; feeds the existing v1 `by_due` index
 *   v   — record format version (1)
 *
 * Due dates are civil dates compared as 'YYYY-MM-DD' strings against the device's local
 * "today" (todayLocal) — never via UTC timestamps.
 */
import { getAll, put, remove } from './db.js';
import { isValidDate, todayLocal } from './dates.js';

export const PRIORITIES = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);
export const PRIORITY_LABEL = Object.freeze({ HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' });
const PRIORITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
export const STATUSES = Object.freeze(['ACTIVE', 'COMPLETED']);
export const FILTERS = Object.freeze(['active', 'today', 'upcoming', 'overdue', 'completed']);
export const TASK_LIMITS = Object.freeze({ title: 120, description: 2000 });

/** Validate form input. Returns { ok, errors, value } with value = { title, description, dueDate, priority }. */
export function validateTask(input) {
  const errors = {};
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim();
  const description = String(input.description ?? '').replace(/\s+$/, '');
  const rawDue = input.dueDate == null ? '' : String(input.dueDate).trim();
  const priority = input.priority == null || input.priority === '' ? 'MEDIUM' : String(input.priority);

  if (!title) errors.title = 'Enter a name for the task.';
  else if (title.length > TASK_LIMITS.title) errors.title = `Keep the task name under ${TASK_LIMITS.title} characters.`;
  if (description.length > TASK_LIMITS.description) errors.description = `Keep the notes under ${TASK_LIMITS.description} characters.`;
  if (rawDue && !isValidDate(rawDue)) errors.dueDate = 'Choose a valid due date, or leave it empty.';
  if (!PRIORITIES.includes(priority)) errors.priority = 'Choose a priority.';

  const ok = Object.keys(errors).length === 0;
  return { ok, errors, value: ok ? { title, description, dueDate: rawDue || null, priority } : null };
}

/**
 * Read a stored record into a safe in-memory task, or null if it can't be used.
 * Missing optional fields get safe defaults IN MEMORY ONLY (the stored record is not rewritten).
 */
export function readStoredTask(rec) {
  if (!rec || typeof rec.id !== 'string' || !rec.id) return null;
  if (typeof rec.title !== 'string' || !rec.title.trim()) return null;
  const status = rec.status ?? 'ACTIVE';
  if (!STATUSES.includes(status)) return null;
  const priority = rec.priority ?? 'MEDIUM';
  if (!PRIORITIES.includes(priority)) return null;
  const dueDate = rec.dueDate ?? null;
  if (dueDate !== null && !isValidDate(dueDate)) return null;
  if (rec.description != null && typeof rec.description !== 'string') return null;
  const completedAt = status === 'COMPLETED' && typeof rec.completedAt === 'string' ? rec.completedAt : null;
  return { ...rec, title: rec.title, description: rec.description ?? '', dueDate, priority, status, completedAt };
}

/* ---------- date state (pure) ---------- */
export function isOverdue(task, today = todayLocal()) {
  return task.status === 'ACTIVE' && !!task.dueDate && task.dueDate < today;
}
/** 'overdue' | 'today' | 'upcoming' | 'none' (active tasks); 'completed' otherwise */
export function dueGroup(task, today = todayLocal()) {
  if (task.status === 'COMPLETED') return 'completed';
  if (!task.dueDate) return 'none';
  if (task.dueDate < today) return 'overdue';
  if (task.dueDate === today) return 'today';
  return 'upcoming';
}
const GROUP_RANK = { overdue: 0, today: 1, upcoming: 2, none: 3 };

/** Active ordering: overdue → today → upcoming (by date) → no date; then priority High→Low; then oldest first. */
export function compareActive(a, b, today = todayLocal()) {
  const ga = GROUP_RANK[dueGroup(a, today)]; const gb = GROUP_RANK[dueGroup(b, today)];
  if (ga !== gb) return ga - gb;
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  const pa = PRIORITY_RANK[a.priority]; const pb = PRIORITY_RANK[b.priority];
  if (pa !== pb) return pa - pb;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}
/** Completed ordering: most recently completed first (missing completedAt last). */
export function compareCompleted(a, b) {
  const ca = a.completedAt || ''; const cb = b.completedAt || '';
  if (ca !== cb) return ca < cb ? 1 : -1;
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/** Local calendar date of an ISO timestamp (device time zone). */
export function localDateOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : todayLocal(d);
}

const newId = () => (globalThis.crypto && crypto.randomUUID
  ? `task-${crypto.randomUUID()}`
  : `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export class TaskStore {
  constructor(db) {
    this.db = db;
    this.tasks = new Map();
    this.skipped = 0;
    this.listeners = new Set();
    this.pending = new Set(); // task ids with a write in flight (blocks double toggles)
  }

  async load() {
    this.tasks.clear(); this.skipped = 0;
    if (!this.db) return;
    for (const rec of await getAll(this.db, 'tasks')) {
      const t = readStoredTask(rec);
      if (t) this.tasks.set(t.id, t); else this.skipped++;
    }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(change) { for (const fn of this.listeners) fn(change); }
  get(id) { return this.tasks.get(id) || null; }
  all() { return Array.from(this.tasks.values()); }
  get size() { return this.tasks.size; }

  /** Write to IndexedDB first; memory and UI change only after the transaction commits. */
  async commit(record, type) {
    if (!this.db) throw new Error('Storage is unavailable, so the task can’t be saved.');
    await put(this.db, 'tasks', record);
    const t = readStoredTask(record);
    this.tasks.set(t.id, t);
    this.emit({ type, task: t });
    return t;
  }

  /** Create (no id) or edit title/description/dueDate/priority. Status and completedAt are kept. */
  async save(input) {
    const r = validateTask(input);
    if (!r.ok) { const e = new Error('Invalid task'); e.validation = r.errors; throw e; }
    const existing = input.id ? this.tasks.get(input.id) : null;
    if (input.id && !existing) throw new Error('That task no longer exists.');
    const now = new Date().toISOString();
    const record = {
      ...(existing || { status: 'ACTIVE', completedAt: null }),
      ...r.value,
      id: existing ? existing.id : newId(),
      createdAt: existing ? (existing.createdAt || now) : now,
      updatedAt: now,
      v: 1,
    };
    if (record.dueDate) record.due = record.dueDate; else delete record.due;
    return this.commit(record, existing ? 'update' : 'create');
  }

  async setCompleted(id, completed) {
    const t = this.tasks.get(id);
    if (!t) throw new Error('That task no longer exists.');
    if (this.pending.has(id)) return t;
    if ((t.status === 'COMPLETED') === completed) return t; // already in that state: no duplicate write
    this.pending.add(id);
    try {
      const now = new Date().toISOString();
      const record = { ...t, status: completed ? 'COMPLETED' : 'ACTIVE', completedAt: completed ? now : null, updatedAt: now };
      return await this.commit(record, completed ? 'complete' : 'reopen');
    } finally { this.pending.delete(id); }
  }

  async delete(id) {
    if (!this.db) throw new Error('Storage is unavailable.');
    const t = this.tasks.get(id);
    await remove(this.db, 'tasks', id);
    this.tasks.delete(id);
    this.emit({ type: 'delete', task: t });
  }

  /* ---------- queries ---------- */
  active(today = todayLocal()) { return this.all().filter((t) => t.status === 'ACTIVE').sort((a, b) => compareActive(a, b, today)); }
  completed() { return this.all().filter((t) => t.status === 'COMPLETED').sort(compareCompleted); }

  /** Tasks for a filter, already ordered. */
  list(filter, today = todayLocal()) {
    if (filter === 'completed') return this.completed();
    const act = this.active(today);
    if (filter === 'today') return act.filter((t) => t.dueDate === today);
    if (filter === 'upcoming') return act.filter((t) => t.dueDate && t.dueDate > today);
    if (filter === 'overdue') return act.filter((t) => isOverdue(t, today));
    return act;
  }

  counts(today = todayLocal()) {
    const c = { active: 0, today: 0, upcoming: 0, overdue: 0, completed: 0, completedToday: 0, total: this.tasks.size };
    for (const t of this.tasks.values()) {
      if (t.status === 'COMPLETED') {
        c.completed++;
        if (t.completedAt && localDateOf(t.completedAt) === today) c.completedToday++;
        continue;
      }
      c.active++;
      const g = dueGroup(t, today);
      if (g === 'overdue') c.overdue++;
      else if (g === 'today') c.today++;
      else if (g === 'upcoming') c.upcoming++;
    }
    return c;
  }
}
