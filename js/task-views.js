/* JX Calendar — task renderers: Tasks screen and the Today tasks card (Phase 4) */
import { addDays, formatShortNoYear, formatShort, parseDate } from './dates.js';
import { dueGroup, isOverdue, localDateOf, PRIORITY_LABEL } from './tasks.js';
import { esc, icon } from './ui.js';

export const TASK_PAGE = 100;

const FILTER_LABEL = { active: 'All active', today: 'Due today', upcoming: 'Upcoming', overdue: 'Overdue', completed: 'Completed' };

function dueText(date, today) {
  if (date === today) return 'Due today';
  if (date === addDays(today, 1)) return 'Due tomorrow';
  if (date === addDays(today, -1)) return 'Was due yesterday';
  const sameYear = parseDate(date).y === parseDate(today).y;
  return `${date < today ? 'Was due' : 'Due'} ${sameYear ? formatShortNoYear(date) : formatShort(date)}`;
}

function priorityBadge(p) {
  return `<span class="prio prio-${p.toLowerCase()}">${p === 'HIGH' ? icon('flag', 'icon icon-xs') : ''}<span class="sr-only">Priority: </span>${PRIORITY_LABEL[p]}</span>`;
}

export function taskRow(t, today) {
  const done = t.status === 'COMPLETED';
  const overdue = isOverdue(t, today);
  let meta = '';
  if (done) {
    const d = t.completedAt ? localDateOf(t.completedAt) : null;
    meta += `<span class="due due-done">${icon('check', 'icon icon-xs')}Done${d ? ` · ${esc(d === today ? 'today' : formatShortNoYear(d))}` : ''}</span>`;
    if (t.dueDate) meta += `<span class="due">Due ${esc(parseDate(t.dueDate).y === parseDate(today).y ? formatShortNoYear(t.dueDate) : formatShort(t.dueDate))}</span>`;
  } else if (t.dueDate) {
    meta += overdue
      ? `<span class="due due-overdue">${icon('clock', 'icon icon-xs')}Overdue · ${esc(t.dueDate === addDays(today, -1) ? 'yesterday' : parseDate(t.dueDate).y === parseDate(today).y ? formatShortNoYear(t.dueDate) : formatShort(t.dueDate))}</span>`
      : `<span class="due${dueGroup(t, today) === 'today' ? ' due-today' : ''}">${esc(dueText(t.dueDate, today))}</span>`;
  }
  meta += priorityBadge(t.priority);
  const name = esc(t.title);
  return `<li class="task-row${done ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}" data-task-row="${esc(t.id)}">
    <button type="button" class="task-check" role="checkbox" aria-checked="${done}" data-act="toggle-task" data-task-id="${esc(t.id)}"
      aria-label="${done ? 'Completed' : 'Mark as done'}: ${name}">${icon('check', 'icon')}</button>
    <button type="button" class="task-main" data-act="edit-task" data-task-id="${esc(t.id)}">
      <span class="task-title">${name}</span>
      <span class="task-meta">${meta}</span>
      ${t.description ? `<span class="task-desc">${esc(t.description)}</span>` : ''}
    </button>
    <button type="button" class="icon-btn task-edit" data-act="edit-task" data-task-id="${esc(t.id)}" aria-label="Edit task: ${name}">${icon('edit')}</button>
  </li>`;
}

function emptyTasks({ title, text, add = true, glyph = 'check-circle' }) {
  return `<div class="empty task-empty">
    <span class="empty-glyph">${icon(glyph, 'icon icon-lg')}</span>
    <p class="empty-title">${esc(title)}</p>
    ${text ? `<p class="empty-text">${esc(text)}</p>` : ''}
    ${add ? `<button type="button" class="btn btn-secondary" data-act="add-task">${icon('plus')}New task</button>` : ''}
  </div>`;
}

const EMPTY = {
  active: { title: 'All done', text: 'You have no active tasks. Enjoy the clear list, or add something new.' },
  today: { title: 'Nothing due today', text: 'Tasks due today will show here.' },
  upcoming: { title: 'No upcoming tasks', text: 'Tasks with a due date after today will show here.' },
  overdue: { title: 'Nothing overdue', text: 'You’re all caught up.', add: false },
  completed: { title: 'No completed tasks yet', text: 'Tasks you tick off will show here.', add: false },
};

export function renderTasks(store, { filter = 'active', today, limit = TASK_PAGE }) {
  const counts = store.counts(today);
  const chips = ['active', 'today', 'upcoming', 'overdue', 'completed'].map((f) => {
    const n = f === 'active' ? counts.active : counts[f];
    return `<button type="button" class="filter-chip${f === 'overdue' && n ? ' has-overdue' : ''}" data-act="task-filter" data-filter="${f}" aria-pressed="${filter === f}">
      ${esc(FILTER_LABEL[f])}<span class="filter-count" aria-label="${n} tasks">${n}</span></button>`;
  }).join('');
  const bar = `<div class="task-filters" role="group" aria-label="Filter tasks">${chips}</div>`;

  if (counts.total === 0) {
    return `${bar}<section class="card">${emptyTasks({ title: 'No tasks yet', text: 'Add the things you need to get done. Due date and priority are optional.' })}</section>`;
  }

  const list = store.list(filter, today);
  if (!list.length) return `${bar}<section class="card" aria-label="${esc(FILTER_LABEL[filter])}">${emptyTasks(EMPTY[filter])}</section>`;

  const shown = list.slice(0, limit);
  const more = list.length > limit ? `<button type="button" class="btn btn-secondary btn-block" data-act="tasks-more">Show more (${list.length - limit} remaining)</button>` : '';
  let body = '';
  if (filter === 'active') {
    const groups = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming'], ['none', 'No due date']];
    for (const [g, label] of groups) {
      const items = shown.filter((t) => dueGroup(t, today) === g);
      if (!items.length) continue;
      body += `<h3 class="list-label task-group-label${g === 'overdue' ? ' is-overdue' : ''}">${esc(label)} <span class="group-count">${items.length}</span></h3><ul class="task-list">${items.map((t) => taskRow(t, today)).join('')}</ul>`;
    }
    body += more;
    const done = store.completed();
    const recent = done.slice(0, 3);
    const doneBlock = done.length
      ? `<section class="card task-card" aria-labelledby="done-h">
          <h2 class="card-title" id="done-h">Completed <span class="group-count">${done.length}</span></h2>
          <ul class="task-list">${recent.map((t) => taskRow(t, today)).join('')}</ul>
          ${done.length > recent.length ? `<button type="button" class="link-btn" data-act="task-filter" data-filter="completed">Show all completed ${icon('chevron-right')}</button>` : ''}
        </section>` : '';
    return `${bar}<section class="card task-card" aria-labelledby="active-h"><h2 class="sr-only" id="active-h">Active tasks</h2>${body}</section>${doneBlock}`;
  }
  return `${bar}<section class="card task-card" aria-labelledby="flt-h">
    <h2 class="card-title" id="flt-h">${esc(FILTER_LABEL[filter])} <span class="group-count">${list.length}</span></h2>
    <ul class="task-list">${shown.map((t) => taskRow(t, today)).join('')}</ul>${more}</section>`;
}

/** Compact Today card: due today + overdue (overdue first), counts, upcoming hint. */
export function renderTodayTasks(store, today) {
  const c = store.counts(today);
  const focus = store.list('active', today).filter((t) => dueGroup(t, today) === 'overdue' || dueGroup(t, today) === 'today');
  const shown = focus.slice(0, 5);
  const weekEnd = addDays(today, 7);
  const upcomingWeek = store.list('upcoming', today).filter((t) => t.dueDate <= weekEnd);
  const stats = [];
  stats.push(`<span class="stat"><strong>${c.today}</strong> due today</span>`);
  stats.push(`<span class="stat${c.overdue ? ' stat-overdue' : ''}"><strong>${c.overdue}</strong> overdue</span>`);
  stats.push(`<span class="stat"><strong>${c.completedToday}</strong> done today</span>`);

  let body;
  if (c.total === 0) {
    body = `<p class="task-hint">No tasks yet. Add one for anything you need to remember.</p>`;
  } else if (!shown.length) {
    body = `<p class="task-hint">Nothing due today.${upcomingWeek.length ? ` Next: <strong>${esc(upcomingWeek[0].title)}</strong> · ${esc(dueText(upcomingWeek[0].dueDate, today).toLowerCase())}.` : ''}</p>`;
  } else {
    body = `<ul class="task-list">${shown.map((t) => taskRow(t, today)).join('')}</ul>
      ${focus.length > shown.length ? `<p class="task-hint">+${focus.length - shown.length} more due today or overdue</p>` : ''}
      ${upcomingWeek.length ? `<p class="task-hint">${upcomingWeek.length} more due in the next 7 days.</p>` : ''}`;
  }
  return `<section class="card today-tasks" aria-labelledby="today-tasks-h">
    <h2 class="card-title" id="today-tasks-h">${icon('check-circle', 'icon icon-title')}Tasks</h2>
    <p class="task-stats">${stats.join('')}</p>
    ${body}
    <a class="link-btn" href="#/tasks">Open tasks ${icon('chevron-right')}</a>
  </section>`;
}
