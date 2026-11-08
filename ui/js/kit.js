// Мелкие компоненты: контекстное меню, модальные окна, ввод строки, тосты, тултипы, выпадающий список.
import { h, fill } from './util.js';
import { icon } from './icons.js';

// ---------- меню ----------
let openMenu = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; }

// items: [{ label, icon, sc, onClick, disabled, danger } | '-' ]
export function menu(x, y, items) {
  closeMenu();
  const m = h('div.ui-menu.jd-menu', { oncontextmenu: e => e.preventDefault() });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('div.sep')); continue; }
    m.append(h(`div.item${it.disabled ? '.dis' : ''}${it.danger ? '.danger' : ''}`, {
      onclick: () => { if (it.disabled) return; closeMenu(); it.onClick?.(); },
    }, h('span.ic', {}, it.icon ? icon(it.icon) : it.dot ? h('i.mdot', { style: { background: it.dot } }) : null), h('span', {}, it.label), it.sc ? h('span.sc', {}, it.sc) : null));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  openMenu = m;
  return m;
}
addEventListener('pointerdown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); }, true);
addEventListener('blur', closeMenu);

export function menuAt(el, items) {
  const r = el.getBoundingClientRect();
  return menu(r.left, r.bottom + 4, items);
}

// ---------- модальное окно ----------
export function modal({ title, body, buttons = [], width = 420, onClose }) {
  const back = h('div.jd-modal-back');
  const close = v => { back.remove(); removeEventListener('keydown', onKey, true); onClose?.(v); };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
      const primary = buttons.find(b => b.primary);
      if (primary) { e.preventDefault(); e.stopPropagation(); primary.onClick?.(close) ?? close(true); }
    }
  };
  const foot = h('div.ft', {}, buttons.map(b => h(`button.ui-btn.${b.primary ? 'primary' : 'secondary'}${b.danger ? '.danger' : ''}`, {
    onclick: () => (b.onClick ? b.onClick(close) : close(b.value ?? null)),
  }, b.label)));
  const box = h('div.jd-modal', { style: { width: width + 'px' } },
    h('div.hd', {}, h('b', {}, title), h('button.ui-ib', { onclick: () => close(null) }, icon('close'))),
    h('div.bd', {}, body), buttons.length ? foot : null);
  back.append(box);
  back.addEventListener('pointerdown', e => { if (e.target === back) close(null); });
  document.body.append(back);
  addEventListener('keydown', onKey, true);
  setTimeout(() => box.querySelector('input,textarea,select')?.focus(), 30);
  return { close, box };
}

export function prompt(title, { value = '', placeholder = '', label = '', multiline = false, ok = 'OK' } = {}) {
  return new Promise(resolve => {
    const inp = multiline ? h('textarea', { rows: 4, placeholder, value }) : h('input', { type: 'text', value, placeholder, spellcheck: false });
    modal({
      title, width: 440,
      body: h('div.col', {}, label ? h('label.dim', {}, label) : null, inp),
      buttons: [
        { label: 'Отмена', value: null },
        { label: ok, primary: true, onClick: close => { close(true); resolve(inp.value); } },
      ],
      onClose: v => { if (v !== true) resolve(null); },
    });
    setTimeout(() => { inp.focus(); inp.select?.(); }, 40);
  });
}

export function confirm(title, text, { ok = 'Удалить', danger = true } = {}) {
  return new Promise(resolve => {
    modal({
      title, width: 420, body: h('div.p', {}, text),
      buttons: [{ label: 'Отмена', value: false }, { label: ok, primary: true, danger, value: true }],
      onClose: v => resolve(v === true),
    });
  });
}

// ---------- тосты ----------
let toasts = null;
export function toast(text, kind = 'info', ms = 3500) {
  toasts ||= document.body.appendChild(h('div.jd-toasts'));
  const t = h(`div.jd-toast.${kind}`, {}, icon(kind === 'err' ? 'error' : kind === 'ok' ? 'success' : kind === 'warn' ? 'warning' : 'info'), h('span', {}, text));
  toasts.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- тултипы (data-tip) ----------
let tipEl = null, tipTimer = null;
addEventListener('pointerover', e => {
  const el = e.target.closest?.('[data-tip]');
  clearTimeout(tipTimer);
  tipEl?.remove(); tipEl = null;
  if (!el) return;
  tipTimer = setTimeout(() => {
    if (!el.isConnected) return;
    tipEl = h('div.ui-tip.jd-tip', {}, el.dataset.tip);
    document.body.append(tipEl);
    const r = el.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2, y = r.bottom + 6;
    if (y + t.height > innerHeight - 4) y = r.top - t.height - 6;
    tipEl.style.left = Math.max(4, Math.min(innerWidth - t.width - 4, x)) + 'px';
    tipEl.style.top = y + 'px';
  }, 550);
});
addEventListener('pointerdown', () => { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null; }, true);

// ---------- выпадающий список ----------
// options: [{ value, label, color? }]
export function select(value, options, onChange, { placeholder = '—', width } = {}) {
  const btn = h('button.ui-dd', { type: 'button', style: width ? { width } : null });
  const render = v => {
    const o = options.find(o => o.value === v);
    fill(btn, o?.color ? h('i.mdot', { style: { background: o.color } }) : null, h(`span.t${o ? '' : '.ph'}`, {}, o ? o.label : placeholder), h('span.chev', {}, icon('down')));
  };
  render(value);
  btn.addEventListener('click', () => {
    menuAt(btn, options.map(o => ({ label: o.label, dot: o.color, icon: o.value === value ? 'check' : null, onClick: () => { value = o.value; render(value); onChange(o.value); } })));
  });
  btn.set = v => { value = v; render(v); };
  return btn;
}
