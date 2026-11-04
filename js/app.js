/* JX Calendar — application bootstrap and controller
 * Phase 1: shell, storage, settings, PWA.  Phase 2: calendar & non-recurring events.
 */
import { openDatabase, SCHEMA_VERSION } from './db.js';
import { DEFAULTS, loadSettings, saveSetting, markLaunch, ensureWeekStart } from './settings.js';
import { EventStore } from './events.js';
import { todayLocal, isValidDate, addDays, shiftMonthKeepDay, parseDate, formatYMD, daysInMonth } from './dates.js';
import { renderToday, renderMonth, renderDay, renderAgenda, modeTabs, AGENDA_PAGE } from './views.js';
import { setupEventDialogs } from './event-dialogs.js';
import { toast } from './ui.js';
import { TaskStore, FILTERS } from './tasks.js';
import { renderTasks, renderTodayTasks, TASK_PAGE } from './task-views.js';
import { setupTaskDialogs } from './task-dialogs.js';
import { exportFromDb, downloadIcs, exportFilename } from './ics-export.js';
import { setupBackupUI } from './backup-ui.js';

export const APP_VERSION = '0.6.2'; // must match VERSION in sw.js

const ROUTES = ['today', 'calendar', 'tasks', 'settings'];
const DEFAULT_ROUTE = 'today';
const CAL_MODES = ['month', 'day', 'agenda'];
const THEME_COLORS = { light: '#0F4D3A', dark: '#0A1A14' };

const state = {
  db: null,
  storageOk: false,
  settings: { ...DEFAULTS },
  store: new EventStore(null),
  tasks: new TaskStore(null),
  dialogs: null,
  taskDialogs: null,
  taskFilter: 'active',
  taskLimit: TASK_PAGE,
  selected: null,
  calMode: 'month',
  agendaLimit: AGENDA_PAGE,
  today: todayLocal(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- Banners ---------------- */
function showBanner(id, { title, text, kind = 'info', action } = {}) {
  const stack = $('#banners');
  let el = document.getElementById(`banner-${id}`);
  if (!el) {
    el = document.createElement('div');
    el.id = `banner-${id}`;
    stack.appendChild(el);
  }
  el.className = `banner${kind === 'error' ? ' is-error' : ''}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = '';
  const body = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  body.appendChild(strong);
  if (text) { const p = document.createElement('p'); p.textContent = text; body.appendChild(p); }
  el.appendChild(body);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.appendChild(btn);
  }
}
function hideBanner(id) { document.getElementById(`banner-${id}`)?.remove(); }

/* ---------------- Theme ---------------- */
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return darkQuery && darkQuery.matches ? 'dark' : 'light';
}
function applyTheme(pref) {
  const theme = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  try { localStorage.setItem('jx.themeHint', pref); } catch (_) { /* hint only */ }
}
darkQuery?.addEventListener?.('change', () => {
  if (state.settings.theme === 'system') applyTheme('system');
});

/* ---------------- Router ----------------
 * #/today · #/tasks · #/settings
 * #/calendar[/month|/day|/agenda][/YYYY-MM-DD] */
function parseHash() {
  const parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const route = ROUTES.includes(parts[0]) ? parts[0] : DEFAULT_ROUTE;
  const out = { route, mode: null, date: null, filter: null };
  if (route === 'tasks') out.filter = FILTERS.includes(parts[1]) ? parts[1] : null;
  if (route === 'calendar') {
    out.mode = CAL_MODES.includes(parts[1]) ? parts[1] : null;
    out.date = isValidDate(parts[2]) ? parts[2] : null;
  }
  return out;
}

function calHash(mode = state.calMode, date = state.selected) {
  return mode === 'agenda' ? '#/calendar/agenda' : `#/calendar/${mode}/${date}`;
}

/** Navigate. replace=true for in-view steps (prev/next) so Back isn't flooded. */
function go(hash, { replace = false, focus = null } = {}) {
  if (location.hash === hash) { render({ focus }); return; }
  if (replace) { history.replaceState(null, '', hash); render({ focus }); }
  else { pendingFocus = focus; location.hash = hash; }
}
let pendingFocus = null;

window.addEventListener('hashchange', () => {
  const f = pendingFocus; pendingFocus = null;
  render({ focus: f || 'main' });
});

/* ---------------- Rendering ---------------- */
function render({ focus = null } = {}) {
  state.today = todayLocal();
  const { route, mode, date, filter } = parseHash();
  if (route === 'tasks') {
    const f = filter || 'active';
    if (f !== state.taskFilter) state.taskLimit = TASK_PAGE;
    state.taskFilter = f;
  }
  if (route === 'calendar') {
    if (mode) state.calMode = mode;
    if (date) state.selected = date;
  }

  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== route; });
  $$('.nav-item').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  let title = route[0].toUpperCase() + route.slice(1);
  if (route === 'today') {
    $('#today-root').innerHTML = renderToday(state.store, state.today) + renderTodayTasks(state.tasks, state.today);
  } else if (route === 'calendar') {
    $('#cal-tabs').innerHTML = modeTabs(state.calMode);
    const ctx = { selected: state.selected, today: state.today, weekStart: state.settings.weekStart, limit: state.agendaLimit };
    const root = $('#cal-root');
    root.dataset.mode = state.calMode;
    if (state.calMode === 'month') root.innerHTML = renderMonth(state.store, ctx);
    else if (state.calMode === 'day') root.innerHTML = renderDay(state.store, ctx);
    else root.innerHTML = renderAgenda(state.store, ctx);
    title = { month: 'Month', day: 'Day', agenda: 'Agenda' }[state.calMode];
  }
  if (route === 'tasks') {
    $('#tasks-root').innerHTML = renderTasks(state.tasks, { filter: state.taskFilter, today: state.today, limit: state.taskLimit });
  }
  document.title = `${title} · JX Calendar`;

  if (focus === 'main') $('#main').focus({ preventScroll: true });
  else if (focus) {
    const el = document.querySelector(focus);
    if (el) el.focus({ preventScroll: false });
  }
}

/** Re-render the visible view only (after data or settings changes). */
function refresh() {
  const active = document.activeElement;
  const keep = active && active.dataset && (active.dataset.act
    ? `[data-act="${active.dataset.act}"]` : active.dataset.date ? `.day-btn[data-date="${active.dataset.date}"]` : null);
  render({ focus: keep && $('#main').contains(active) ? keep : null });
}

/* ---------------- Calendar interactions ---------------- */
function selectDate(date, { focusCell = false } = {}) {
  state.selected = date;
  go(calHash('month', date), { replace: true, focus: focusCell ? `.day-btn[data-date="${date}"]` : null });
}

function stepMonth(delta) {
  const { y, m } = parseDate(state.selected);
  const target = shiftMonthKeepDay(formatYMD(y, m, 1), delta);
  // Land on today when navigating into the current month, otherwise on the 1st.
  const date = target.slice(0, 7) === state.today.slice(0, 7) ? state.today : target;
  state.selected = date;
  go(calHash('month', date), { replace: true, focus: `[data-act="${delta < 0 ? 'prev' : 'next'}-month"]` });
}

function handleAction(act, el) {
  switch (act) {
    case 'add': state.dialogs.openCreate(el.dataset.date || state.selected || state.today, el); break;
    case 'prev-month': stepMonth(-1); break;
    case 'next-month': stepMonth(1); break;
    case 'prev-day': state.selected = addDays(state.selected, -1); go(calHash('day'), { replace: true, focus: '[data-act="prev-day"]' }); break;
    case 'next-day': state.selected = addDays(state.selected, 1); go(calHash('day'), { replace: true, focus: '[data-act="next-day"]' }); break;
    case 'today':
      state.selected = state.today;
      go(calHash(state.calMode === 'agenda' ? 'month' : state.calMode, state.today), { replace: true, focus: state.calMode === 'month' ? `.day-btn[data-date="${state.today}"]` : '[data-act="add"]' });
      break;
    case 'agenda-more': state.agendaLimit += AGENDA_PAGE; refresh(); break;
    case 'add-task': state.taskDialogs.openCreate({}, el); break;
    case 'edit-task': state.taskDialogs.openEdit(el.dataset.taskId, el); break;
    case 'toggle-task': toggleTask(el); break;
    case 'task-filter': go(`#/tasks/${el.dataset.filter}`, { focus: `[data-act="task-filter"][data-filter="${el.dataset.filter}"]` }); break;
    case 'tasks-more': state.taskLimit += TASK_PAGE; refresh(); break;
    default: break;
  }
}

/* ---------------- Task completion ---------------- */
const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
async function toggleTask(btn) {
  const id = btn.dataset.taskId;
  const task = state.tasks.get(id);
  if (!task || state.tasks.pending.has(id)) return;
  const completing = task.status !== 'COMPLETED';
  const row = btn.closest('.task-row');
  row?.classList.add(completing ? 'is-completing' : 'is-reopening');
  btn.setAttribute('aria-checked', String(completing));
  try {
    await state.tasks.setCompleted(id, completing);
    toast(completing ? `Done: “${task.title}”` : `Reopened “${task.title}”`);
  } catch (err) {
    console.warn('[JX] task update failed', err);
    row?.classList.remove('is-completing', 'is-reopening');
    btn.setAttribute('aria-checked', String(!completing));
    toast('Couldn’t update the task. Nothing was changed.', 'error');
  }
}

/** Re-render after a task change, keeping focus near the affected row. */
function refreshAfterTask(change) {
  const delay = change.type === 'complete' && !reducedMotion.matches ? 320 : 0;
  setTimeout(() => {
    const active = document.activeElement;
    const keepTask = active && active.dataset && active.dataset.taskId;
    render();
    if (keepTask) {
      const same = document.querySelector(`[data-act="${active.dataset.act}"][data-task-id="${CSS.escape(keepTask)}"]`);
      (same || document.querySelector('.view:not([hidden]) [data-act="toggle-task"]') || $('#main')).focus({ preventScroll: true });
    }
  }, delay);
}

function bindMain() {
  const main = $('#main');
  main.addEventListener('click', (e) => {
    const evBtn = e.target.closest('[data-event-id]');
    if (evBtn) { state.dialogs.openDetail(evBtn.dataset.eventId, evBtn); return; }
    const actBtn = e.target.closest('[data-act]');
    if (actBtn && !actBtn.disabled) { handleAction(actBtn.dataset.act, actBtn); return; }
    const day = e.target.closest('.day-btn');
    if (day) {
      const date = day.dataset.date;
      if (date === state.selected) go(calHash('day', date)); // second tap opens the day view
      else selectDate(date, { focusCell: true });
    }
  });

  // Keyboard navigation in the month grid (roving tabindex).
  main.addEventListener('keydown', (e) => {
    const day = e.target.closest('.day-btn');
    if (!day) return;
    const date = day.dataset.date;
    const { y, m, d } = parseDate(date);
    let target = null;
    switch (e.key) {
      case 'ArrowLeft': target = addDays(date, -1); break;
      case 'ArrowRight': target = addDays(date, 1); break;
      case 'ArrowUp': target = addDays(date, -7); break;
      case 'ArrowDown': target = addDays(date, 7); break;
      case 'PageUp': target = shiftMonthKeepDay(date, -1); break;
      case 'PageDown': target = shiftMonthKeepDay(date, 1); break;
      case 'Home': target = formatYMD(y, m, 1); break;
      case 'End': target = formatYMD(y, m, daysInMonth(y, m)); break;
      default: return;
    }
    e.preventDefault();
    if (d && target) selectDate(target, { focusCell: true });
  });
}

/* ---------------- Settings UI ---------------- */
function syncSettingsForm() {
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(state.settings)) {
    const input = form.querySelector(`input[name="${key}"][value="${value}"]`);
    if (input) input.checked = true;
  }
}
function setSaveState(text) { $('#save-state').textContent = text; }

function bindSettingsForm() {
  $('#settings-form').addEventListener('change', async (e) => {
    const { name, value } = e.target;
    if (!(name in DEFAULTS)) return;
    const previous = state.settings[name];
    state.settings[name] = value;
    if (name === 'theme') applyTheme(value);
    if (!state.storageOk) {
      setSaveState('Changed for this session only — storage is unavailable.');
      return;
    }
    try {
      await saveSetting(state.db, name, value);
      setSaveState('Saved on this device.');
      announceChange();
    } catch (err) {
      console.warn('[JX] setting save failed', err);
      state.settings[name] = previous;
      if (name === 'theme') applyTheme(previous);
      syncSettingsForm();
      setSaveState('Could not save. Your previous setting was kept.');
    }
  });
}

/* ---------------- Reload everything from the database (after a committed restore) ---------------- */
async function reloadFromDb() {
  await state.store.load();
  await state.tasks.load();
  state.settings = await loadSettings(state.db);
  hideBanner('skipped'); hideBanner('skipped-tasks');
  applyTheme(state.settings.theme);
  syncSettingsForm();
  setSaveState('');
  render();
}

/* ---------------- Other open tabs/windows ----------------
 * Each tab keeps its own in-memory copy of the data. When one tab saves, the others reload from
 * the database, so an older tab can never write a stale copy over a newer change.
 * Reloading never announces itself (no ping-pong). Without BroadcastChannel, a tab reloads
 * whenever it becomes visible again. */
const syncChannel = (() => { try { return 'BroadcastChannel' in self ? new BroadcastChannel('jx-calendar-data') : null; } catch (_) { return null; } })();
function announceChange() {
  try { if (syncChannel) syncChannel.postMessage({ type: 'changed' }); } catch (_) { /* best effort */ }
}
let syncRunning = false; let syncAgain = false;
async function syncFromDb() {
  if (!state.storageOk) return;
  if (syncRunning || (state.backupUI && state.backupUI.isBusy())) { syncAgain = true; setTimeout(retrySync, 300); return; }
  syncRunning = true;
  try { await reloadFromDb(); } catch (err) { console.warn('[JX] reload after a change in another tab failed', err); }
  finally { syncRunning = false; }
}
function retrySync() { if (syncAgain) { syncAgain = false; syncFromDb(); } }
if (syncChannel) syncChannel.onmessage = (e) => { if (e.data && e.data.type === 'changed') syncFromDb(); };

/* ---------------- ICS export (read-only) ---------------- */
let exporting = false;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function showExportResult(kind, title, lines = []) {
  const box = $('#export-result');
  box.hidden = false;
  box.className = `export-result is-${kind}`;
  box.innerHTML = '';
  const strong = document.createElement('p'); strong.className = 'export-result-title'; strong.textContent = title; box.appendChild(strong);
  if (lines.length) {
    const ul = document.createElement('ul');
    for (const l of lines) { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); }
    box.appendChild(ul);
  }
}
async function runExport() {
  if (exporting) return;
  const btn = $('#export-ics'); const label = btn.querySelector('span');
  if (!state.storageOk) { showExportResult('error', 'Export isn’t available because storage could not be opened.'); return; }
  exporting = true; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); label.textContent = 'Preparing file…';
  try {
    const { text, summary: s } = await exportFromDb(state.db);
    if (!text) {
      const lines = s.skipped ? [`${plural(s.skipped, 'saved event')} could not be exported because ${s.skipped === 1 ? 'it is' : 'they are'} damaged. Nothing was changed.`] : [];
      showExportResult('info', 'There are no events to export yet. Add an event first, then export.', lines);
      return;
    }
    const filename = exportFilename(todayLocal());
    downloadIcs(text, filename);
    const lines = [
      `${plural(s.oneTime, 'one-time event')}`,
      `${plural(s.series, 'repeating series', 'repeating series')}`,
      `${plural(s.modified, 'changed date')} in repeating series`,
      `${plural(s.cancelled, 'cancelled date')} in repeating series`,
    ];
    if (s.separateOccurrences) lines.push(`${plural(s.separateOccurrences, 'changed date')} that switched between all-day and timed ${s.separateOccurrences === 1 ? 'is' : 'are'} included as a separate event.`);
    if (s.staleIgnored) lines.push(`${plural(s.staleIgnored, 'outdated change')} to repeating events ${s.staleIgnored === 1 ? 'was' : 'were'} not exported (no longer on the schedule).`);
    if (s.skipped) lines.push(`${plural(s.skipped, 'damaged saved event')} could not be exported and ${s.skipped === 1 ? 'was' : 'were'} left unchanged.`);
    showExportResult(s.skipped ? 'warn' : 'success', `Downloaded ${filename}`, lines);
    toast('Calendar exported');
  } catch (err) {
    console.warn('[JX] export failed', err);
    showExportResult('error', 'The export could not be created. Your calendar was not changed. Please try again.');
    toast('Export failed', 'error');
  } finally {
    exporting = false; btn.disabled = false; btn.removeAttribute('aria-busy'); label.textContent = 'Export Calendar (.ics)';
  }
}

/* ---------------- Diagnostics ---------------- */
function setDiag(key, text) {
  const el = document.querySelector(`[data-diag="${key}"]`);
  if (el) el.textContent = text;
}

async function updateStorageDiagnostics() {
  setDiag('appVersion', APP_VERSION);
  setDiag('schema', state.storageOk ? `v${state.db.version}` : 'Not available');
  setDiag('storage', state.storageOk ? 'On this device' : 'Unavailable');
  if (navigator.storage && navigator.storage.persisted) {
    try {
      let persisted = await navigator.storage.persisted();
      if (!persisted && state.storageOk && navigator.storage.persist) {
        persisted = await navigator.storage.persist();
      }
      setDiag('persist', persisted ? 'Granted' : 'Not granted (download backups regularly)');
    } catch (_) { setDiag('persist', 'Unknown'); }
  } else {
    setDiag('persist', 'Not supported by this browser');
  }
}

/* ---------------- Storage errors ---------------- */
const ERROR_TITLES = {
  UNSUPPORTED: 'Storage not available',
  NEWER_VERSION: 'Saved data is from a newer version',
  UPGRADE_FAILED: 'Data update failed',
  QUOTA: 'Device storage is full',
  TIMEOUT: 'Storage is not responding',
  OPEN_FAILED: 'Storage could not be opened',
};

function reportStorageError(err) {
  console.warn('[JX] storage init failed:', err.code, err.cause || err);
  showBanner('storage', {
    kind: 'error',
    title: ERROR_TITLES[err.code] || 'Storage problem',
    text: `${err.message} Events and settings will not be saved until this is fixed.`,
    action: { label: 'Retry', onClick: () => location.reload() },
  });
}

/* ---------------- Online / offline ---------------- */
function updateOnline() { $('#offline-chip').hidden = navigator.onLine; }
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);

/* ---------------- Day rollover ---------------- */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!syncChannel) syncFromDb(); // no cross-tab messages in this browser: re-read on return
  else if (todayLocal() !== state.today) refresh();
});

/* ---------------- Service worker ---------------- */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    setDiag('sw', 'Not available in this browser');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

    const promptUpdate = (worker) => showBanner('update', {
      title: 'Update ready',
      text: 'A new version of the app has been downloaded.',
      action: {
        label: 'Reload',
        onClick: () => {
          if ((state.dialogs && state.dialogs.isBusy()) || (state.taskDialogs && state.taskDialogs.isBusy())
            || (state.backupUI && state.backupUI.isBusy())) return; // never reload mid-save or mid-restore
          try { sessionStorage.setItem('jx.updateRequested', '1'); } catch (_) {}
          worker.postMessage({ type: 'SKIP_WAITING' });
        },
      },
    });

    if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        // Only prompt when replacing an existing worker, not on first install.
        if (nw.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(nw);
      });
    });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      setDiag('sw', 'Ready');
      if (reloading || !sessionStorage.getItem('jx.updateRequested')) return;
      reloading = true;
      sessionStorage.removeItem('jx.updateRequested');
      location.reload();
    });

    await navigator.serviceWorker.ready;
    setDiag('sw', navigator.serviceWorker.controller ? 'Ready' : 'Ready after you reopen the app');
  } catch (err) {
    console.warn('[JX] service worker registration failed', err);
    setDiag('sw', 'Unavailable');
  }
}

/* ---------------- Boot ---------------- */
async function boot() {
  state.selected = state.today; // the calendar opens on the current month with today selected
  state.dialogs = setupEventDialogs({
    store: state.store,
    onGoToDate: (date) => { state.selected = date; go(calHash('day', date)); },
    getWeekStart: () => state.settings.weekStart,
  });
  state.taskDialogs = setupTaskDialogs({ store: state.tasks });
  bindSettingsForm();
  bindMain();
  $('#export-ics').addEventListener('click', runExport);
  state.backupUI = setupBackupUI({
    getDb: () => state.db,
    appVersion: APP_VERSION,
    isStorageOk: () => state.storageOk,
    onRestored: async () => { await reloadFromDb(); announceChange(); },
  });
  state.backupUI.setCurrentCounts(() => ({ events: state.store.size, tasks: state.tasks.size }));
  updateOnline();
  applyTheme(state.settings.theme);
  render();

  try {
    const { db } = await openDatabase({
      onBlocked: () => showBanner('blocked', {
        title: 'Close other JX tabs',
        text: 'The app is open in another tab with an older version. Close it to finish updating.',
      }),
      onVersionChange: () => {
        state.storageOk = false;
        showBanner('versionchange', {
          title: 'App updated in another tab',
          text: 'Reload to keep using the latest version.',
          action: { label: 'Reload', onClick: () => location.reload() },
        });
      },
    });
    hideBanner('blocked');
    state.db = db;
    state.storageOk = true;
    const { firstLaunch } = await markLaunch(db);
    await ensureWeekStart(db, { firstLaunch });
    state.settings = await loadSettings(db);
    state.store.db = db;
    await state.store.load();
    state.tasks.db = db;
    await state.tasks.load();
    if (state.tasks.skipped > 0) {
      showBanner('skipped-tasks', {
        title: `${state.tasks.skipped} saved task${state.tasks.skipped > 1 ? 's' : ''} could not be shown`,
        text: 'They are still stored on this device and have not been changed.',
      });
    }
    if (state.store.skipped > 0) {
      showBanner('skipped', {
        title: `${state.store.skipped} saved event${state.store.skipped > 1 ? 's' : ''} could not be shown`,
        text: 'They are still stored on this device and have not been changed.',
      });
    }
  } catch (err) {
    state.storageOk = false;
    if (err && err.name === 'StorageError') reportStorageError(err);
    else reportStorageError({ code: 'OPEN_FAILED', message: 'Storage could not be opened.', cause: err });
  }

  state.store.onChange(() => { refresh(); announceChange(); });
  state.tasks.onChange((change) => { refreshAfterTask(change); announceChange(); });
  applyTheme(state.settings.theme);
  syncSettingsForm();
  render();
  document.documentElement.setAttribute('data-boot', state.storageOk ? 'ready' : 'storage-error');
  updateStorageDiagnostics();
  registerServiceWorker();
}

// Week-start or theme changes re-render the calendar immediately.
document.addEventListener('change', (e) => {
  if (e.target.closest && e.target.closest('#settings-form') && e.target.name === 'weekStart') refresh();
});

if (SCHEMA_VERSION < 1) throw new Error('Invalid schema version');
boot();
