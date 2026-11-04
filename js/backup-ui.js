/* JX Calendar — Backup & Restore UI (Settings) (Phase 6) */
import { createBackup, backupFilename, downloadJson, readBackupFile, validateBackupText, restoreBackup, BackupError } from './backup.js';
import { todayLocal } from './dates.js';
import { openDialog, closeDialog, wireDialog, toast } from './ui.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function showResult(el, kind, title, lines = []) {
  el.hidden = false;
  el.className = `export-result is-${kind}`;
  el.innerHTML = '';
  const p = document.createElement('p'); p.className = 'export-result-title'; p.textContent = title; el.appendChild(p);
  if (lines.length) {
    const ul = document.createElement('ul');
    for (const l of lines) { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); }
    el.appendChild(ul);
  }
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(d); } catch (_) { return d.toString(); }
}

export function setupBackupUI({ getDb, appVersion, onRestored, isStorageOk }) {
  const $ = (id) => document.getElementById(id);
  const dlg = $('restore-dialog');
  let busy = false; let restoring = false; let pending = null; let fileName = '';

  /* ---------- backup ---------- */
  async function downloadBackup(resultEl = $('backup-result')) {
    if (busy) return false;
    if (!isStorageOk()) { showResult(resultEl, 'error', 'A backup can’t be made because storage could not be opened.'); return false; }
    busy = true;
    const btn = $('backup-download'); const label = btn.querySelector('span');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); label.textContent = 'Preparing backup…';
    try {
      const { json, backup, excluded, integrityAvailable } = await createBackup(getDb(), { appVersion });
      const filename = backupFilename(todayLocal());
      downloadJson(json, filename); // only after the snapshot transaction completed and the JSON was checked
      const s = backup.summary;
      const lines = [
        `${plural(s.oneTimeEvents, 'one-time event')}, ${plural(s.recurringSeries, 'repeating series', 'repeating series')}`,
        `${plural(s.cancelledOccurrences, 'cancelled date')} and ${plural(s.modifiedOccurrences, 'changed date')} in repeating series`,
        `${plural(s.activeTasks, 'active task')}, ${plural(s.completedTasks, 'completed task')}`,
        `${plural(backup.counts.settings, 'setting')}`,
      ];
      const skipped = excluded.events + excluded.tasks + excluded.settings;
      if (skipped) lines.push(`${plural(skipped, 'damaged saved item')} could not be included and ${skipped === 1 ? 'was' : 'were'} left unchanged.`);
      if (!integrityAvailable) lines.push('This browser can’t add a checksum, so accidental damage to this file can’t be detected later.');
      showResult(resultEl, skipped ? 'warn' : 'success', `Downloaded ${filename}`, lines);
      toast('Backup downloaded');
      return true;
    } catch (err) {
      console.warn('[JX] backup failed', err);
      showResult(resultEl, 'error', 'The backup couldn’t be created, so nothing was downloaded. Your data was not changed. Please try again.');
      toast('Backup failed', 'error');
      return false;
    } finally {
      busy = false; btn.disabled = false; btn.removeAttribute('aria-busy'); label.textContent = 'Download Backup (.json)';
    }
  }

  /* ---------- restore: choose, read, validate (no database changes) ---------- */
  const input = $('restore-file');
  $('restore-pick').addEventListener('click', () => { if (!busy && !restoring) input.click(); });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = ''; // allow choosing the same file again
    if (!file) return;
    const out = $('restore-result');
    fileName = file.name;
    if (!isStorageOk()) { showResult(out, 'error', 'Restoring isn’t available because storage could not be opened.'); return; }
    busy = true;
    showResult(out, 'info', `Checking “${file.name}”…`);
    try {
      const text = await readBackupFile(file);
      pending = await validateBackupText(text);
      out.hidden = true;
      openPreview();
    } catch (err) {
      pending = null;
      if (err instanceof BackupError) {
        const lines = [...(err.details || []).slice(0, 5)];
        if ((err.details || []).length > 5) lines.push(`…and ${err.details.length - 5} more.`);
        if (!/Nothing was changed/.test(err.message)) lines.push('Nothing was changed.');
        showResult(out, 'error', `“${file.name}”: ${err.message}`, lines);
      } else {
        console.warn('[JX] restore check failed', err);
        showResult(out, 'error', `“${file.name}” couldn’t be checked. Nothing was changed.`);
      }
    } finally { busy = false; }
  });

  /* ---------- preview ---------- */
  function fillDl(dl, rows) {
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.append(dt, dd);
    }
  }
  function openPreview() {
    const p = pending.preview;
    $('rd-file').textContent = fileName;
    fillDl($('rd-info'), [
      ['Created', fmtDateTime(p.createdAt)],
      ['Made with', `JX Calendar ${p.appVersion}`],
      ['Backup format', `Version ${p.formatVersion}`],
      ['Compatibility', 'Compatible with this version'],
      ['File check', p.checksum === 'verified' ? 'Passed (no damage found)' : 'No checksum in this file'],
    ]);
    const settingText = [p.settings.theme && `Theme: ${p.settings.theme[0].toUpperCase()}${p.settings.theme.slice(1)}`, p.settings.weekStart && `Week starts ${p.settings.weekStart === 'sunday' ? 'Sunday' : 'Monday'}`].filter(Boolean).join(' · ') || 'None (defaults will be used)';
    fillDl($('rd-counts'), [
      ['One-time events', String(p.oneTimeEvents)],
      ['Repeating series', String(p.recurringSeries)],
      ['Cancelled dates in series', String(p.cancelledOccurrences)],
      ['Changed dates in series', String(p.modifiedOccurrences)],
      ['Active tasks', String(p.activeTasks)],
      ['Completed tasks', String(p.completedTasks)],
      ['Settings', settingText],
    ]);
    const notes = $('rd-notes');
    notes.innerHTML = ''; notes.hidden = !pending.notes.length;
    for (const n of pending.notes) { const li = document.createElement('li'); li.textContent = n; notes.appendChild(li); }
    const cur = currentCounts();
    $('rd-current').textContent = `You currently have ${plural(cur.events, 'saved event')} (one-time and repeating) and ${plural(cur.tasks, 'task')} in JX.`;
    $('rd-check').checked = false;
    $('rd-confirm').disabled = true;
    dlg.querySelector('.sheet-body').scrollTop = 0;
    openDialog(dlg, { focus: '#rd-cancel', returnFocus: $('restore-pick') });
  }
  let currentCounts = () => ({ events: 0, tasks: 0 });

  $('rd-check').addEventListener('change', () => { $('rd-confirm').disabled = !$('rd-check').checked || restoring; });
  const cancel = () => { if (restoring) return; pending = null; closeDialog(dlg); };
  wireDialog(dlg, cancel);
  $('rd-cancel').addEventListener('click', cancel);
  $('rd-save-current').addEventListener('click', () => downloadBackup($('backup-result')));

  /* ---------- restore: atomic replace ---------- */
  $('rd-confirm').addEventListener('click', async () => {
    if (restoring || !pending || !$('rd-check').checked) return; // deliberate confirmation + duplicate guard
    restoring = true;
    const btn = $('rd-confirm');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Restoring…';
    $('rd-cancel').disabled = true; $('rd-check').disabled = true;
    const out = $('restore-result');
    try {
      const res = await restoreBackup(getDb(), pending);   // resolves only after the transaction committed
      await onRestored();                                   // reload views from the database state
      const p = pending.preview;
      closeDialog(dlg, { restoreFocus: false });
      const lines = [
        `${plural(p.oneTimeEvents, 'one-time event')}, ${plural(p.recurringSeries, 'repeating series', 'repeating series')} (${plural(p.cancelledOccurrences, 'cancelled date')}, ${plural(p.modifiedOccurrences, 'changed date')})`,
        `${plural(p.activeTasks, 'active task')}, ${plural(p.completedTasks, 'completed task')}`,
        `${plural(p.counts.settings, 'setting')}`,
      ];
      if (res.verified) {
        lines.push('Checked after restoring: everything matches the backup.');
        showResult(out, 'success', 'Backup restored', lines);
        toast('Backup restored');
      } else {
        lines.push('A check after restoring found differences from the backup. Please download a backup now and try restoring again.');
        showResult(out, 'warn', 'Backup restored, but the final check found differences', lines);
      }
      $('restore-pick').focus({ preventScroll: true });
    } catch (err) {
      console.warn('[JX] restore failed', err);
      closeDialog(dlg, { restoreFocus: false });
      try { await onRestored(); } catch (_) { /* views keep their previous state */ }
      showResult(out, 'error', 'The restore couldn’t be completed. Your existing data has not been changed.', ['You can keep using JX as before, or try again.']);
      toast('Restore failed — nothing was changed', 'error');
      $('restore-pick').focus({ preventScroll: true });
    } finally {
      restoring = false; pending = null;
      btn.removeAttribute('aria-busy'); btn.textContent = 'Replace and restore';
      $('rd-cancel').disabled = false; $('rd-check').disabled = false; $('rd-check').checked = false;
    }
  });

  $('backup-download').addEventListener('click', () => downloadBackup());
  return {
    isBusy: () => busy || restoring,
    setCurrentCounts: (fn) => { currentCounts = fn; },
  };
}
