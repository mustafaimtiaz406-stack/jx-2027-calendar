/* JX Calendar — task form (create/edit) and delete confirmation (Phase 4) */
import { validateTask, localDateOf } from './tasks.js';
import { todayLocal, addDays, formatShortNoYear, formatLong } from './dates.js';
import { openDialog, closeDialog, wireDialog, toast } from './ui.js';

const FIELDS = ['title', 'dueDate', 'priority', 'description'];

export function setupTaskDialogs({ store }) {
  const $ = (id) => document.getElementById(id);
  const dlg = $('task-form');
  const form = $('task-form-el');
  const saveBtn = $('tf-save');
  const delDlg = $('task-delete');
  const summary = $('tf-summary');
  const input = (n) => form.elements.namedItem(n);
  let editingId = null;
  let saving = false;
  let deleting = false;

  function setError(field, msg) {
    const el = $(`tf-${field}-err`);
    const target = field === 'priority' ? form.querySelector('.prio-seg') : field === 'dueDate' ? $('tf-due') : input(field);
    if (el) { el.textContent = msg || ''; el.hidden = !msg; }
    if (target) { if (msg) target.setAttribute('aria-invalid', 'true'); else target.removeAttribute('aria-invalid'); }
  }
  function clearErrors() { FIELDS.forEach((f) => setError(f, '')); summary.hidden = true; summary.textContent = ''; }

  function syncQuick() {
    const v = $('tf-due').value; const today = todayLocal();
    form.querySelectorAll('[data-due]').forEach((b) => {
      const on = (b.dataset.due === 'today' && v === today) || (b.dataset.due === 'tomorrow' && v === addDays(today, 1)) || (b.dataset.due === 'none' && !v);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function fill(t) {
    input('title').value = t.title || '';
    input('description').value = t.description || '';
    $('tf-due').value = t.dueDate || '';
    form.querySelector(`input[name="priority"][value="${t.priority || 'MEDIUM'}"]`).checked = true;
    const note = $('tf-status');
    if (t.status === 'COMPLETED') {
      const d = t.completedAt ? localDateOf(t.completedAt) : null;
      note.textContent = `Completed${d ? ` on ${formatShortNoYear(d)}` : ''}. Saving changes keeps it completed.`;
      note.hidden = false;
    } else note.hidden = true;
    clearErrors(); syncQuick();
  }

  function openCreate(defaults = {}, opener) {
    editingId = null;
    fill({ title: '', description: '', dueDate: defaults.dueDate || null, priority: 'MEDIUM', status: 'ACTIVE' });
    $('tf-heading').textContent = 'New task';
    saveBtn.textContent = 'Save task';
    $('tf-delete').hidden = true;
    dlg.querySelector('.sheet-body').scrollTop = 0;
    openDialog(dlg, { focus: '#tf-title', returnFocus: opener });
  }

  function openEdit(id, opener) {
    const t = store.get(id);
    if (!t) { toast('That task no longer exists.', 'error'); return; }
    editingId = id;
    fill({ ...t }); // copy: the stored task changes only after a successful save
    $('tf-heading').textContent = 'Edit task';
    saveBtn.textContent = 'Save changes';
    $('tf-delete').hidden = false;
    dlg.querySelector('.sheet-body').scrollTop = 0;
    openDialog(dlg, { focus: '#tf-title', returnFocus: opener });
  }

  wireDialog(dlg, () => { if (!saving) closeDialog(dlg); });
  form.addEventListener('input', (e) => { if (e.target.name) setError(e.target.name, ''); if (e.target.name === 'dueDate') syncQuick(); });
  form.addEventListener('change', (e) => { if (e.target.name === 'dueDate') syncQuick(); if (e.target.name === 'priority') setError('priority', ''); });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-due]');
    if (!b) return;
    const today = todayLocal();
    $('tf-due').value = b.dataset.due === 'today' ? today : b.dataset.due === 'tomorrow' ? addDays(today, 1) : '';
    setError('dueDate', ''); syncQuick();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return; // rapid repeated submissions
    clearErrors();
    const raw = {
      id: editingId || undefined,
      title: input('title').value,
      description: input('description').value,
      dueDate: $('tf-due').value,
      priority: (form.querySelector('input[name="priority"]:checked') || {}).value,
    };
    // A date input with partially typed text reports '' but is invalid — treat as an error, not "no date".
    if (!raw.dueDate && $('tf-due').validity && $('tf-due').validity.badInput) raw.dueDate = 'invalid';
    const v = validateTask(raw);
    if (!v.ok) {
      const fields = FIELDS.filter((f) => v.errors[f]);
      fields.forEach((f) => setError(f, v.errors[f]));
      summary.textContent = fields.length === 1 ? 'Please fix the highlighted field.' : `Please fix the ${fields.length} highlighted fields.`;
      summary.hidden = false;
      const first = fields[0];
      (first === 'dueDate' ? $('tf-due') : first === 'priority' ? form.querySelector('input[name="priority"]') : input(first)).focus();
      return;
    }
    saving = true; saveBtn.disabled = true; saveBtn.setAttribute('aria-busy', 'true');
    const label = saveBtn.textContent; saveBtn.textContent = 'Saving…';
    try {
      const t = await store.save(raw);
      closeDialog(dlg);
      toast(editingId ? 'Task updated' : `Task added${t.dueDate ? ` · due ${formatShortNoYear(t.dueDate)}` : ''}`);
    } catch (err) {
      console.warn('[JX] task save failed', err);
      summary.textContent = 'The task could not be saved. Nothing was changed.';
      summary.hidden = false;
      toast('Couldn’t save the task. Please try again.', 'error');
    } finally {
      saving = false; saveBtn.disabled = false; saveBtn.removeAttribute('aria-busy'); saveBtn.textContent = label;
    }
  });

  /* ----- delete ----- */
  $('tf-delete').addEventListener('click', () => {
    const t = store.get(editingId);
    if (!t) return;
    closeDialog(dlg, { restoreFocus: false });
    $('td-name').textContent = t.title;
    $('td-meta').textContent = [t.status === 'COMPLETED' ? 'Completed task' : 'Active task', t.dueDate ? `due ${formatLong(t.dueDate)}` : 'no due date'].join(' · ');
    openDialog(delDlg, { focus: '#td-cancel' });
  });
  const cancelDelete = () => {
    if (deleting) return;
    closeDialog(delDlg, { restoreFocus: false });
    if (store.get(editingId)) openEdit(editingId); // back to the unchanged task
  };
  wireDialog(delDlg, cancelDelete);
  $('td-cancel').addEventListener('click', cancelDelete);
  $('td-confirm').addEventListener('click', async () => {
    if (deleting) return;
    deleting = true;
    const btn = $('td-confirm'); btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try {
      const title = store.get(editingId)?.title || 'Task';
      await store.delete(editingId);
      closeDialog(delDlg, { restoreFocus: false });
      $('main').focus({ preventScroll: true });
      toast(`Deleted “${title}”`);
    } catch (err) {
      console.warn('[JX] task delete failed', err);
      toast('Couldn’t delete the task. It has not been changed.', 'error');
    } finally {
      deleting = false; btn.disabled = false; btn.removeAttribute('aria-busy');
    }
  });

  return { openCreate, openEdit, isBusy: () => saving || deleting };
}

