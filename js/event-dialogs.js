/* JX Calendar — event form (create / edit / edit series / edit one occurrence), event details,
 * delete confirmation, and the scope-choice dialog for repeating events. */
import { CATEGORIES, validateEvent, categoryLabel, ImpactError } from './events.js';
import { validateRule, defaultsFor } from './recurrence.js';
import {
  normalizeTime, timeToMinutes, minutesToTime, todayLocal, isValidDate, weekdayLong, weekdayShort,
  monthName, daysInMonth, formatLong, formatShort, shiftMonthKeepDay,
} from './dates.js';
import { openDialog, closeDialog, wireDialog, toast, esc } from './ui.js';
import { whenText, describeRecurrence } from './views.js';

const EVENT_FIELDS = ['title', 'startDate', 'startTime', 'endDate', 'endTime'];
const REPEAT_FIELDS = ['interval', 'weekdays', 'monthly', 'yearly', 'until', 'count', 'pattern'];
const ALL_FIELDS = [...EVENT_FIELDS, ...REPEAT_FIELDS, 'category', 'description'];
const UNIT = { DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'] };

/** Default start/end for a new timed event on `date`. */
function defaultTimes(date, now = new Date()) {
  if (date === todayLocal(now)) {
    const next = now.getHours() + 1;
    if (next <= 22) return { allDay: false, startTime: minutesToTime(next * 60), endTime: minutesToTime((next + 1) * 60) };
    return { allDay: true, startTime: '09:00', endTime: '10:00' }; // too late today for a 1-hour slot
  }
  return { allDay: false, startTime: '09:00', endTime: '10:00' };
}

export function setupEventDialogs({ store, onGoToDate, getWeekStart = () => 'monday' }) {
  const $ = (id) => document.getElementById(id);
  const formDlg = $('event-form');
  const form = $('event-form-el');
  const detailDlg = $('event-detail');
  const confirmDlg = $('confirm-delete');
  const choiceDlg = $('choice-dialog');
  const saveBtn = $('ef-save');
  const allDayInput = $('ef-allday');
  const summary = $('ef-summary');
  const input = (name) => form.elements.namedItem(name);

  /* ---------- static option lists ---------- */
  $('ef-categories').innerHTML = CATEGORIES.map((c) =>
    `<label class="cat-option cat-${c.id}"><input type="radio" name="category" value="${c.id}"><span><i aria-hidden="true"></i>${esc(c.label)}</span></label>`).join('');
  $('ef-ordwd').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => `<option value="${d}">${esc(weekdayLong(d))}</option>`).join('');
  $('ef-ymonth').innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${esc(monthName(i + 1))}</option>`).join('');
  function renderWeekdayChips() {
    const order = getWeekStart() === 'sunday' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
    const checked = new Set(readWeekdays());
    $('ef-weekdays').innerHTML = order.map((d) =>
      `<label class="wd-chip"><input type="checkbox" name="weekday" value="${d}"${checked.has(d) ? ' checked' : ''}><span aria-hidden="true">${esc(weekdayShort(d).slice(0, 2))}</span><span class="sr-only">${esc(weekdayLong(d))}</span></label>`).join('');
  }
  const readWeekdays = () => Array.from(form.querySelectorAll('input[name="weekday"]:checked')).map((i) => Number(i.value));

  /* ---------- state ---------- */
  let mode = 'create';        // 'create' | 'edit' | 'series' | 'occurrence'
  let editingId = null;       // record id for edit/series
  let occurrenceKey = null;   // instance key for occurrence edits
  let saving = false;
  let detailKey = null;
  let patternTouched = false; // user changed pattern fields → stop auto-following the start date
  let prev = { startDate: '', startTime: '' };

  /* ---------- errors ---------- */
  function errorTarget(field) {
    switch (field) {
      case 'category': return $('ef-categories');
      case 'weekdays': return $('ef-weekdays');
      case 'monthly': return form.querySelector('input[name="monthlyType"]:checked')?.value === 'ORDINAL' ? $('ef-ordinal') : $('ef-monthday');
      case 'yearly': return $('ef-yday');
      case 'pattern': return $('ef-freq');
      default: return input(field);
    }
  }
  function setError(field, message) {
    const el = $(`ef-${field}-err`);
    const target = errorTarget(field);
    if (el) { el.textContent = message || ''; el.hidden = !message; }
    if (target && target.setAttribute) {
      if (message) target.setAttribute('aria-invalid', 'true'); else target.removeAttribute('aria-invalid');
    }
    target?.closest?.('.field, .sub-field')?.classList.toggle('has-error', !!message);
  }
  function clearErrors() {
    ALL_FIELDS.forEach((f) => setError(f, ''));
    summary.hidden = true; summary.textContent = '';
  }
  function showErrors(errors) {
    const fields = ALL_FIELDS.filter((f) => errors[f]);
    fields.forEach((f) => setError(f, errors[f]));
    summary.textContent = fields.length === 1 ? 'Please fix the highlighted field.' : `Please fix the ${fields.length} highlighted fields.`;
    summary.hidden = false;
    const first = fields[0];
    const focusEl = first === 'category' ? form.querySelector('input[name="category"]')
      : first === 'weekdays' ? form.querySelector('input[name="weekday"]') : errorTarget(first);
    focusEl?.focus();
  }

  /* ---------- all-day ---------- */
  function syncAllDay() {
    const allDay = allDayInput.checked;
    form.classList.toggle('is-all-day', allDay);
    ['startTime', 'endTime'].forEach((n) => { input(n).disabled = allDay; if (allDay) setError(n, ''); });
  }

  /* ---------- repeat section ---------- */
  function applyPatternDefaults(startDate) {
    if (!isValidDate(startDate)) return;
    const d = defaultsFor(startDate);
    form.querySelectorAll('input[name="weekday"]').forEach((i) => { i.checked = d.weekdays.includes(Number(i.value)); });
    input('monthDay').value = d.monthlyDay;
    input('ordinal').value = String(d.ordinal);
    input('ordWeekday').value = String(d.ordinalWeekday);
    input('yMonth').value = String(d.yearlyMonth);
    input('yDay').value = d.yearlyDay;
  }

  function fillRepeat(rule, startDate) {
    renderWeekdayChips();
    applyPatternDefaults(startDate);
    input('freq').value = rule ? rule.frequency : '';
    input('interval').value = rule ? rule.interval : 1;
    form.querySelector(`input[name="monthlyType"][value="${rule?.monthlyPattern?.type || 'DAY'}"]`).checked = true;
    form.querySelector(`input[name="endType"][value="${rule?.endType || 'NEVER'}"]`).checked = true;
    input('untilDate').value = rule?.untilDate || '';
    input('count').value = rule?.count || 10;
    if (rule?.frequency === 'WEEKLY') form.querySelectorAll('input[name="weekday"]').forEach((i) => { i.checked = rule.weekdays.includes(Number(i.value)); });
    if (rule?.monthlyPattern?.type === 'DAY') input('monthDay').value = rule.monthlyPattern.day;
    if (rule?.monthlyPattern?.type === 'ORDINAL') { input('ordinal').value = String(rule.monthlyPattern.ordinal); input('ordWeekday').value = String(rule.monthlyPattern.weekday); }
    if (rule?.yearlyPattern) { input('yMonth').value = String(rule.yearlyPattern.month); input('yDay').value = rule.yearlyPattern.day; }
    patternTouched = !!rule;
    syncRepeat();
  }

  /** Rule input exactly as the form shows it (null = does not repeat). */
  function readRule() {
    const frequency = input('freq').value;
    if (!frequency) return null;
    const r = { frequency, interval: input('interval').value === '' ? NaN : Number(input('interval').value), endType: form.querySelector('input[name="endType"]:checked')?.value };
    if (frequency === 'WEEKLY') r.weekdays = readWeekdays();
    if (frequency === 'MONTHLY') {
      const type = form.querySelector('input[name="monthlyType"]:checked')?.value;
      r.monthlyPattern = type === 'ORDINAL'
        ? { type, ordinal: Number(input('ordinal').value), weekday: Number(input('ordWeekday').value) }
        : { type: 'DAY', day: input('monthDay').value === '' ? NaN : Number(input('monthDay').value) };
    }
    if (frequency === 'YEARLY') r.yearlyPattern = { month: Number(input('yMonth').value), day: input('yDay').value === '' ? NaN : Number(input('yDay').value) };
    if (r.endType === 'UNTIL') r.untilDate = input('untilDate').value;
    if (r.endType === 'COUNT') r.count = input('count').value === '' ? NaN : Number(input('count').value);
    return r;
  }

  function syncRepeat() {
    const freq = input('freq').value;
    $('ef-repeat-options').hidden = !freq;
    form.querySelectorAll('.sub-field[data-freq]').forEach((f) => { f.hidden = f.dataset.freq !== freq; });
    const n = Number(input('interval').value) || 1;
    if (freq) $('ef-interval-unit').textContent = UNIT[freq][n === 1 ? 0 : 1];
    const mtype = form.querySelector('input[name="monthlyType"]:checked')?.value;
    $('ef-monthly-hint').hidden = !(freq === 'MONTHLY' && mtype === 'DAY' && Number(input('monthDay').value) >= 29);
    $('ef-yearly-hint').hidden = !(freq === 'YEARLY' && input('yMonth').value === '2' && input('yDay').value === '29');
    const endType = form.querySelector('input[name="endType"]:checked')?.value;
    input('untilDate').disabled = endType !== 'UNTIL';
    input('count').disabled = endType !== 'COUNT';
    input('monthDay').disabled = mtype !== 'DAY';
    input('ordinal').disabled = mtype !== 'ORDINAL';
    input('ordWeekday').disabled = mtype !== 'ORDINAL';
    const rule = freq ? validateRule(readRule(), input('startDate').value) : null;
    $('ef-repeat-summary').textContent = rule && rule.ok ? `${describeRecurrence(rule.rule)}.` : '';
  }

  /* ---------- open / fill ---------- */
  function setMode(m, note) {
    mode = m;
    $('ef-repeat-block').hidden = m === 'occurrence';
    $('ef-mode-note').hidden = !note;
    $('ef-mode-text').textContent = note || '';
  }

  function fill(values, rule = null) {
    input('title').value = values.title || '';
    input('description').value = values.description || '';
    input('startDate').value = values.startDate;
    input('endDate').value = values.endDate;
    input('startTime').value = values.startTime || '09:00';
    input('endTime').value = values.endTime || '10:00';
    allDayInput.checked = !!values.allDay;
    const cat = form.querySelector(`input[name="category"][value="${values.category || 'personal'}"]`);
    if (cat) cat.checked = true;
    prev = { startDate: values.startDate, startTime: input('startTime').value };
    fillRepeat(rule, values.startDate);
    syncAllDay();
    clearErrors();
  }

  function show(title, button, opener) {
    $('event-form-title').textContent = title;
    saveBtn.textContent = button;
    formDlg.querySelector('.sheet-body').scrollTop = 0;
    openDialog(formDlg, { focus: '#ef-title', returnFocus: opener });
  }

  function openCreate(date, opener) {
    editingId = null; occurrenceKey = null;
    setMode('create');
    const d = isValidDate(date) ? date : todayLocal();
    fill({ title: '', description: '', startDate: d, endDate: d, category: 'personal', ...defaultTimes(d) });
    show('New event', 'Save event', opener);
  }

  function openEdit(id, opener) {
    const rec = store.get(id);
    if (!rec) { toast('That event no longer exists.', 'error'); return; }
    editingId = id; occurrenceKey = null;
    if (rec.recurrence) {
      setMode('series', 'You’re editing every event in this series.');
      fill({ ...rec }, rec.recurrence);
      show('Edit series', 'Save series', opener);
    } else {
      setMode('edit');
      fill({ ...rec }); // a copy: the stored record is never touched until a successful save
      show('Edit event', 'Save changes', opener);
    }
  }

  function openEditOccurrence(key, opener) {
    const inst = store.getInstance(key);
    if (!inst) { toast('That event no longer exists.', 'error'); return; }
    editingId = inst.masterId; occurrenceKey = key;
    setMode('occurrence', `Only the event on ${formatLong(inst.occurrenceId)} will change. The rest of the series stays the same.`);
    fill({ ...inst });
    show('Edit this event', 'Save this event', opener);
  }

  function cancelForm() { if (!saving) closeDialog(formDlg); }
  wireDialog(formDlg, cancelForm);

  /* ---------- field coupling ---------- */
  form.addEventListener('input', (e) => {
    const name = e.target.name;
    if (!name) return;
    if (['interval', 'weekday', 'monthDay', 'ordinal', 'ordWeekday', 'yMonth', 'yDay', 'monthlyType'].includes(name)) patternTouched = true;
    const map = { weekday: 'weekdays', monthDay: 'monthly', ordinal: 'monthly', ordWeekday: 'monthly', yMonth: 'yearly', yDay: 'yearly', untilDate: 'until', freq: 'pattern' };
    setError(map[name] || name, '');
    if (name !== 'title' && name !== 'description') syncRepeat();
  });
  // Typing in an end-condition or monthly field selects its option.
  form.addEventListener('focusin', (e) => {
    const pick = { untilDate: 'ef-end-until', count: 'ef-end-count', monthDay: 'ef-mtype-day', ordinal: 'ef-mtype-ord', ordWeekday: 'ef-mtype-ord' }[e.target.name];
    if (pick && !$(pick).checked) { $(pick).checked = true; syncRepeat(); }
  });
  form.addEventListener('click', (e) => {
    // disabled inputs don't receive focus; clicking their row selects the option
    const row = e.target.closest('.choice-row');
    if (row) { const radio = row.querySelector('input[type="radio"]'); if (radio && !radio.checked) { radio.checked = true; syncRepeat(); const f = row.querySelector('input:not([type="radio"]), select'); if (f && e.target === f) f.focus(); } }
  });
  form.addEventListener('change', (e) => {
    const name = e.target.name;
    if (name === 'allDay') syncAllDay();
    if (name === 'category') setError('category', '');
    if (name === 'freq') {
      if (!patternTouched) applyPatternDefaults(input('startDate').value);
      if (input('freq').value && !form.querySelector('input[name="endType"]:checked')) $('ef-end-never').checked = true;
    }
    if (name === 'endType' && e.target.value === 'UNTIL' && !input('untilDate').value && isValidDate(input('startDate').value)) {
      input('untilDate').value = shiftMonthKeepDay(input('startDate').value, 3);
    }
    if (name === 'startDate') {
      const s = input('startDate').value; const end = input('endDate').value;
      // Keep single-day events single-day, and never leave the end before the start.
      if (isValidDate(s) && (!isValidDate(end) || end === prev.startDate || end < s)) input('endDate').value = s;
      if (!patternTouched) applyPatternDefaults(s);
      prev.startDate = s;
      setError('endDate', '');
    }
    if (name === 'startTime') {
      const s = normalizeTime(input('startTime').value); const old = normalizeTime(prev.startTime); const end = normalizeTime(input('endTime').value);
      if (s && input('startDate').value === input('endDate').value) {
        const dur = old && end && timeToMinutes(end) > timeToMinutes(old) ? timeToMinutes(end) - timeToMinutes(old) : 60;
        input('endTime').value = minutesToTime(Math.min(timeToMinutes(s) + dur, 23 * 60 + 59));
        setError('endTime', '');
      }
      prev.startTime = input('startTime').value;
    }
    if (name === 'yMonth') input('yDay').max = String(daysInMonth(2000, Number(input('yMonth').value)));
    syncRepeat();
  });

  /* ---------- submit ---------- */
  function readEvent() {
    return {
      title: input('title').value,
      description: input('description').value,
      startDate: input('startDate').value,
      endDate: input('endDate').value,
      startTime: input('startTime').value,
      endTime: input('endTime').value,
      allDay: allDayInput.checked,
      category: (form.querySelector('input[name="category"]:checked') || {}).value || '',
    };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return; // duplicate-submission guard
    clearErrors();
    const raw = readEvent();
    const rule = mode === 'occurrence' ? null : readRule();
    const errors = { ...validateEvent(raw).errors };
    if (rule) Object.assign(errors, validateRule(rule, raw.startDate).errors);
    if (Object.keys(errors).length) { showErrors(errors); return; }

    saving = true;
    saveBtn.disabled = true; saveBtn.setAttribute('aria-busy', 'true');
    const label = saveBtn.textContent; saveBtn.textContent = 'Saving…';
    try {
      let msg;
      if (mode === 'occurrence') {
        await store.saveOccurrence(occurrenceKey, raw);
        msg = 'This event was updated';
      } else {
        const payload = { ...raw, id: editingId || undefined, recurrence: rule };
        let saved;
        try {
          saved = await store.save(payload);
        } catch (err) {
          if (!(err instanceof ImpactError)) throw err;
          const ok = await confirmImpact(err.impact);
          if (!ok) return; // user went back to the form; nothing written
          saved = await store.save(payload, { confirmedImpact: true });
        }
        msg = mode === 'series' ? 'Series updated'
          : mode === 'edit' ? 'Changes saved'
          : `${saved.recurrence ? 'Repeating event added' : 'Event added'} · ${whenText(saved).split(' · ')[0]}`;
      }
      closeDialog(formDlg);
      toast(msg);
    } catch (err) {
      console.warn('[JX] event save failed', err);
      if (err.validation) showErrors(err.validation);
      summary.textContent = 'The event could not be saved. Nothing was changed.';
      summary.hidden = false;
      toast('Couldn’t save the event. Please try again.', 'error');
    } finally {
      saving = false;
      saveBtn.disabled = false; saveBtn.removeAttribute('aria-busy'); saveBtn.textContent = label;
    }
  });

  /* ---------- choice dialog (promise-based) ---------- */
  let choiceResolve = null;
  function askChoice({ title, desc, options = [], confirmLabel = 'Continue', danger = false, glyph = 'repeat', returnFocus }) {
    $('ch-title').textContent = title;
    $('ch-desc').textContent = desc || '';
    $('ch-desc').hidden = !desc;
    $('ch-legend').textContent = title;
    $('ch-glyph').classList.toggle('is-danger', danger);
    $('ch-glyph-use').setAttribute('href', `#i-${glyph}`);
    const list = $('ch-options');
    list.querySelectorAll('.choice-option').forEach((n) => n.remove());
    list.hidden = !options.length;
    options.forEach((o, i) => {
      const lab = document.createElement('label');
      lab.className = 'choice-option';
      lab.innerHTML = `<input type="radio" name="choice" value="${esc(o.value)}"${i === 0 ? ' checked' : ''}><span class="choice-text"><strong></strong><span></span></span>`;
      lab.querySelector('strong').textContent = o.label;
      lab.querySelector('.choice-text > span').textContent = o.hint || '';
      list.appendChild(lab);
    });
    const btn = $('ch-confirm');
    btn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    const setLabel = () => {
      const v = list.querySelector('input[name="choice"]:checked')?.value;
      btn.textContent = typeof confirmLabel === 'function' ? confirmLabel(v) : confirmLabel;
    };
    list.onchange = setLabel;
    setLabel();
    return new Promise((resolve) => {
      choiceResolve = resolve;
      openDialog(choiceDlg, { focus: options.length ? 'input[name="choice"]:checked' : '#ch-cancel', returnFocus });
    });
  }
  function finishChoice(value) {
    const r = choiceResolve; choiceResolve = null;
    closeDialog(choiceDlg, { restoreFocus: value === null });
    if (r) r(value);
  }
  wireDialog(choiceDlg, () => finishChoice(null));
  $('ch-cancel').addEventListener('click', () => finishChoice(null));
  $('choice-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const opts = $('ch-options').querySelector('input[name="choice"]:checked');
    finishChoice(opts ? opts.value : true);
  });

  async function confirmImpact(impact) {
    const n = impact.invalid.length;
    const dates = impact.invalid.slice(0, 3).map((d) => formatShort(d)).join(', ') + (n > 3 ? ` and ${n - 3} more` : '');
    let desc;
    if (impact.stopsRepeating) {
      desc = `Only the event on ${formatLong(input('startDate').value)} will remain. All other dates in this series will be removed${n ? `, including ${n} date${n > 1 ? 's' : ''} you changed or cancelled` : ''}.`;
    } else {
      desc = `${n} date${n > 1 ? 's' : ''} you changed or cancelled (${dates}) no longer fit${n > 1 ? '' : 's'} the new schedule and will be removed.${impact.kept ? ` ${impact.kept} other change${impact.kept > 1 ? 's' : ''} will be kept.` : ''}`;
    }
    const r = await askChoice({
      title: impact.stopsRepeating ? 'Stop repeating this event?' : 'Change the series schedule?',
      desc, confirmLabel: impact.stopsRepeating ? 'Stop repeating' : 'Save changes', danger: true, glyph: 'alert',
      returnFocus: saveBtn,
    });
    return r === true;
  }

  /* ---------- details ---------- */
  function fillDetail(ev) {
    const cat = $('ed-cat');
    cat.className = `cat-chip cat-${ev.category}`;
    cat.innerHTML = `<i aria-hidden="true"></i>${esc(categoryLabel(ev.category))}`;
    $('ed-title').textContent = ev.title;
    $('ed-when').textContent = whenText(ev);
    const desc = $('ed-desc');
    desc.textContent = ev.description || '';
    desc.hidden = !ev.description;
    $('ed-repeat').hidden = !ev.recurring;
    if (ev.recurring) {
      $('ed-repeat-text').textContent = describeRecurrence(ev.recurrence);
      const moved = ev.overridden && ev.startDate !== ev.occurrenceId;
      $('ed-repeat-sub').textContent = ev.overridden
        ? (moved ? `Changed for this date only (usually ${formatLong(ev.occurrenceId)}).` : 'Changed for this date only.') : '';
      $('ed-repeat-sub').hidden = !ev.overridden;
    }
  }

  function openDetail(key, opener) {
    const ev = store.getInstance(key);
    if (!ev) { toast('That event no longer exists.', 'error'); return; }
    detailKey = key;
    fillDetail(ev);
    openDialog(detailDlg, { focus: '#ed-edit', returnFocus: opener });
  }
  wireDialog(detailDlg, () => closeDialog(detailDlg));

  const cardFor = (key) => document.querySelector(`[data-event-id="${CSS.escape(key)}"]`);

  $('ed-edit').addEventListener('click', async () => {
    const ev = store.getInstance(detailKey);
    if (!ev) return;
    const key = detailKey;
    closeDialog(detailDlg, { restoreFocus: false });
    if (!ev.recurring) { openEdit(key, cardFor(key)); return; }
    const scope = await askChoice({
      title: 'Edit repeating event',
      desc: `“${ev.title}” is part of a series.`,
      options: [
        { value: 'one', label: 'This event only', hint: `Only ${formatLong(ev.startDate)} changes.` },
        { value: 'all', label: 'All events in the series', hint: describeRecurrence(ev.recurrence) },
      ],
      confirmLabel: (v) => (v === 'all' ? 'Edit series' : 'Edit this event'),
      returnFocus: cardFor(key),
    });
    if (scope === 'one') openEditOccurrence(key, cardFor(key));
    else if (scope === 'all') openEdit(ev.masterId, cardFor(key));
    else openDetail(key, cardFor(key));
  });

  $('ed-goto').addEventListener('click', () => {
    const ev = store.getInstance(detailKey);
    closeDialog(detailDlg, { restoreFocus: false });
    if (ev) onGoToDate(ev.startDate);
  });

  $('ed-delete').addEventListener('click', async () => {
    const ev = store.getInstance(detailKey);
    if (!ev) return;
    const key = detailKey;
    closeDialog(detailDlg, { restoreFocus: false });
    if (!ev.recurring) {
      $('cd-name').textContent = ev.title;
      $('cd-when').textContent = whenText(ev);
      openDialog(confirmDlg, { focus: '#cd-cancel' });
      return;
    }
    const scope = await askChoice({
      title: 'Delete repeating event?',
      desc: `“${ev.title}” is part of a series. Deleted events can’t be restored.`,
      options: [
        { value: 'one', label: 'This event only', hint: `Removes ${formatLong(ev.startDate)}. Other dates stay.` },
        { value: 'all', label: 'All events in the series', hint: `Removes every date (${describeRecurrence(ev.recurrence).replace(/^Every/, 'every')}).` },
      ],
      confirmLabel: (v) => (v === 'all' ? 'Delete entire series' : 'Delete this event'),
      danger: true, glyph: 'trash',
    });
    if (scope === null) { if (store.getInstance(key)) openDetail(key, cardFor(key)); return; }
    try {
      if (scope === 'one') { await store.cancelOccurrence(key); toast(`Deleted “${ev.title}” on ${formatShort(ev.startDate)}`); }
      else { await store.delete(ev.masterId); toast(`Deleted the series “${ev.title}”`); }
      $('main').focus({ preventScroll: true });
    } catch (err) {
      console.warn('[JX] delete failed', err);
      toast('Couldn’t delete. Nothing was changed.', 'error');
    }
  });

  /* ---------- one-time delete confirmation (Phase 2) ---------- */
  let deleting = false;
  const cancelDelete = () => {
    if (deleting) return;
    closeDialog(confirmDlg, { restoreFocus: false });
    if (store.getInstance(detailKey)) openDetail(detailKey); // back to the unchanged event
  };
  wireDialog(confirmDlg, cancelDelete);
  $('cd-cancel').addEventListener('click', cancelDelete);
  $('cd-confirm').addEventListener('click', async () => {
    if (deleting) return;
    deleting = true;
    const btn = $('cd-confirm');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try {
      const title = store.get(detailKey)?.title || 'Event';
      await store.delete(detailKey);
      closeDialog(confirmDlg, { restoreFocus: false });
      $('main').focus({ preventScroll: true });
      toast(`Deleted “${title}”`);
    } catch (err) {
      console.warn('[JX] delete failed', err);
      toast('Couldn’t delete the event. It has not been changed.', 'error');
    } finally {
      deleting = false; btn.disabled = false; btn.removeAttribute('aria-busy');
    }
  });

  return { openCreate, openEdit, openDetail, isBusy: () => saving || deleting || !!choiceResolve };
}

