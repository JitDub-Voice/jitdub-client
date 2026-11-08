// Обновления приложения: проверка релизов на GitHub (latest.json), уведомление в углу окна,
// скачивание с прогрессом, установка и перезапуск. Работает только в собранном приложении (Tauri).
import { h, fill } from './util.js';
import { icon } from './icons.js';
import { isTauri } from './api.js';
import { toast } from './kit.js';

const T = window.__TAURI__;
let card = null;
let available = null;
let installing = false;
let dismissed = null; // версия, которую отложили «Позже» — до перезапуска не напоминаем

export async function appVersion() {
  try { return isTauri ? await T.app.getVersion() : 'web'; } catch { return '?'; }
}

export const updateAvailable = () => available;

// manual — проверка по кнопке: сообщить и когда обновлений нет
export async function checkForUpdates({ manual = false } = {}) {
  if (!isTauri) { if (manual) toast('Обновления проверяются в установленном приложении', 'info'); return null; }
  if (installing) return available;
  try {
    const info = await T.core.invoke('check_update');
    available = info || null;
    if (info && (manual || dismissed !== info.version)) showCard(info);
    else if (manual) toast('У вас последняя версия JitDub', 'ok', 2500);
    window.dispatchEvent(new CustomEvent('jitdub:update', { detail: available }));
    return available;
  } catch (e) {
    if (manual) toast(`Не удалось проверить обновления: ${e}`, 'err');
    return null;
  }
}

function showCard(info) {
  card?.remove();
  const notes = (info.notes || '').trim();
  card = h('div.jd-update', {},
    h('div.hd', {}, icon('download'), h('b', {}, `Доступна версия ${info.version}`), h('span.dim', {}, `у вас ${info.current}`)),
    notes ? h('div.notes', {}, notes.split('\n').slice(0, 8).join('\n')) : null,
    h('div.prog', { style: { display: 'none' } }, h('div.bar', {}, h('i')), h('span')),
    h('div.acts', {},
      h('button.ui-btn.secondary.slim', { onclick: () => { dismissed = info.version; card.remove(); card = null; } }, 'Позже'),
      h('button.ui-btn.primary.slim', { onclick: install }, 'Обновить и перезапустить')));
  document.body.append(card);
}

let unlisten = null;
async function install() {
  if (installing) return;
  installing = true;
  const prog = card.querySelector('.prog');
  prog.style.display = '';
  fill(card.querySelector('.acts'), h('span.dim', {}, 'Не закрывайте приложение — после установки оно перезапустится'));
  unlisten ||= await T.event.listen('jitdub-update', e => {
    const { received, total, done } = e.payload;
    const pct = total ? Math.floor((received / total) * 100) : 0;
    prog.querySelector('i').style.width = (done ? 100 : pct) + '%';
    prog.querySelector('span').textContent = done ? 'Устанавливаю…' : total ? `${pct}% · ${(received / 1048576).toFixed(1)} из ${(total / 1048576).toFixed(1)} МБ` : `${(received / 1048576).toFixed(1)} МБ`;
  });
  try {
    await T.core.invoke('install_update');
  } catch (e) {
    installing = false;
    toast(`Обновление не установилось: ${e}`, 'err', 7000);
    showCard(available);
  }
}

// первая проверка через несколько секунд после запуска, дальше — раз в 3 часа
export function startUpdateChecks() {
  if (!isTauri) return;
  setTimeout(() => checkForUpdates(), 5000);
  setInterval(() => checkForUpdates(), 3 * 3600 * 1000);
}
