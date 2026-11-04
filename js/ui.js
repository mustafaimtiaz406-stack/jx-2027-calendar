/* JX Calendar — small UI helpers: escaping, icons, toasts, modal dialogs */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Inline icon from the <symbol> sprite in index.html. Decorative unless a label is given. */
export function icon(name, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

/* ---------- Toasts ---------- */
let toastTimer = null;
export function toast(message, kind = 'success') {
  const region = document.getElementById('toasts');
  if (!region) return;
  region.innerHTML = '';
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(kind === 'error' ? 'alert' : 'check')}<span></span>`;
  el.querySelector('span').textContent = message;
  region.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

/* ---------- Dialogs ----------
 * Native <dialog>.showModal(): background is inert, Escape closes, focus stays inside.
 * We add: page scroll lock while any dialog is open, and focus return to the opener. */
const openers = new WeakMap();

function updateScrollLock() {
  const anyOpen = document.querySelector('dialog[open]');
  document.documentElement.classList.toggle('modal-open', !!anyOpen);
}

export function openDialog(dlg, { focus, returnFocus } = {}) {
  if (!dlg.open) {
    openers.set(dlg, returnFocus || document.activeElement);
    dlg.showModal();
  }
  updateScrollLock();
  const target = focus ? dlg.querySelector(focus) : null;
  if (target) requestAnimationFrame(() => target.focus());
}

export function closeDialog(dlg, { restoreFocus = true } = {}) {
  if (dlg.open) dlg.close();
  updateScrollLock();
  const opener = openers.get(dlg);
  openers.delete(dlg);
  if (restoreFocus && opener && document.contains(opener) && typeof opener.focus === 'function') {
    opener.focus({ preventScroll: true });
  }
}

/** Wire close buttons, Escape and backdrop clicks for a dialog. */
export function wireDialog(dlg, onCancel) {
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); onCancel(); });
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { onCancel(); return; }
    if (e.target === dlg) { // click on backdrop area
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) onCancel();
    }
  });
  dlg.addEventListener('close', updateScrollLock);
}

/* Keep the focused field visible when the viewport shrinks (e.g. on-screen keyboard opens). */
function keepFocusedFieldVisible() {
  const el = document.activeElement;
  if (el && el.closest && el.closest('dialog[open]') && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
    requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
  }
}
window.addEventListener('resize', keepFocusedFieldVisible);
if (window.visualViewport) window.visualViewport.addEventListener('resize', keepFocusedFieldVisible);
