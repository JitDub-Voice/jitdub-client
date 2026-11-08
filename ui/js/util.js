// DOM-помощники, форматирование времени, мелкие утилиты.
import { session } from './api.js';

export function h(tag, attrs = {}, ...kids) {
  // 'tag.класс.класс#id'
  const [base, id] = tag.split('#');
  const [name, ...cls] = base.split('.');
  const e = document.createElement(name || 'div');
  if (cls.length) e.className = cls.join(' ');
  if (id) e.id = id;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
export const $ = (sel, root = document) => root.querySelector(sel);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function uid(prefix = '') {
  const b = crypto.getRandomValues(new Uint8Array(10));
  let s = prefix;
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return s;
}

// 83.25 → «01:23.250» (с часами, если нужно)
export function fmtTime(t, ms = true) {
  if (!Number.isFinite(t)) t = 0;
  const neg = t < 0; t = Math.abs(t);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = Math.floor(t % 60);
  const frac = Math.floor((t % 1) * 1000);
  const p2 = n => String(n).padStart(2, '0');
  let s = (hh ? `${hh}:${p2(mm)}` : p2(mm)) + ':' + p2(ss);
  if (ms) s += '.' + String(frac).padStart(3, '0');
  return (neg ? '-' : '') + s;
}

// «1:23.5», «83.5», «01:02:03,400» → секунды
export function parseTime(s) {
  s = String(s).trim().replace(',', '.');
  if (!s) return NaN;
  const parts = s.split(':').map(Number);
  if (parts.some(p => !Number.isFinite(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export const dbToGain = db => (db <= -60 ? 0 : 10 ** (db / 20));
export const gainToDb = g => (g <= 0.001 ? -60 : 20 * Math.log10(g));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function throttle(fn, ms) {
  let last = 0, t = null, args;
  return (...a) => {
    args = a;
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...args); }
    else if (!t) t = setTimeout(() => { t = null; last = performance.now(); fn(...args); }, ms - (now - last));
  };
}

// Простой эмиттер событий
export class Emitter {
  constructor() { this.map = new Map(); }
  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.map.get(evt)?.delete(fn);
  }
  emit(evt, ...a) { for (const fn of this.map.get(evt) || []) { try { fn(...a); } catch (e) { console.error(e); } } }
}

export function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase();
}

// Аватарка: картинка с сервера, если загружена, иначе инициалы на служебном цвете пользователя
export function avatar(user, size = 22) {
  const e = h('span.avatar', { title: user?.displayName || '' });
  e.style.cssText = `--c:${user?.color || '#5A5D63'};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`;
  if (user?.avatar) {
    const img = h('img', { src: (user.avatar.startsWith('/') ? session.server : '') + user.avatar, alt: '', draggable: false, loading: 'lazy' });
    img.addEventListener('error', () => { img.remove(); e.textContent = initials(user.displayName); });
    e.append(img);
  } else {
    e.textContent = initials(user?.displayName);
  }
  return e;
}

// Цвет персонажа по имени (стабильный)
const CHAR_COLORS = ['#E08855', '#5FAD65', '#4FB3D9', '#955AE0', '#E06AA8', '#F2C55C', '#24A394', '#DB5C5C', '#A3C44E', '#83ACFC'];
export function charColor(name) {
  if (!name) return '#6F737A';
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return CHAR_COLORS[x % CHAR_COLORS.length];
}

export const fmtBytes = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : (n / 1024).toFixed(0) + ' КБ');

export function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'только что';
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return new Date(iso).toLocaleDateString('ru-RU');
}
