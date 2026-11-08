// Иконки (набор из maistep, стиль JetBrains New UI): тёмная тема берёт *_dark.svg, при отсутствии — обычный вариант.
import { h } from './util.js';

export const ICONS = {
  play: 'run/run', stop: 'run/stop', pause: 'run/pause', restart: 'run/restart', rec: 'rec',
  toStart: 'playFirst', toEnd: 'playLast', back: 'playBack', fwd: 'playForward',
  add: 'general/add', delete: 'general/delete', close: 'general/close', closeSmall: 'general/closeSmall',
  edit: 'general/edit', copy: 'general/copy', settings: 'general/settings', search: 'general/search',
  down: 'general/chevronDown', up: 'general/chevronUp', left: 'general/chevronLeft', right: 'general/chevronRight',
  more: 'general/moreVertical', moreH: 'general/moreHorizontal', refresh: 'general/refresh', filter: 'general/filter',
  import: 'general/import', export: 'general/export', upload: 'general/upload', download: 'general/download',
  exit: 'general/exit', help: 'general/help', show: 'general/show', hide: 'general/hide', lock: 'general/locked',
  history: 'general/history', check: 'general/checkmark', undo: 'general/undo', redo: 'general/redo', save: 'general/save',
  zoomIn: 'image/zoomIn', zoomOut: 'image/zoomOut', fit: 'image/fitContent', split: 'split', link: 'link',
  users: 'cwmUsers', folder: 'nodes/folder', text: 'fileTypes/text',
  error: 'status/error', warning: 'status/warning', info: 'status/info', success: 'status/success',
  // свои (только тёмный вариант)
  mic: 'jd/mic!', magnet: 'jd/magnet!', film: 'jd/film!', user: 'jd/user!', headphones: 'jd/headphones!',
  chat: 'jd/chat!', script: 'jd/script!',
};

export function icon(key, { size = 16, cls = '' } = {}) {
  let path = ICONS[key] || key;
  const plain = path.endsWith('!');
  path = path.replace(/!$/, '');
  const img = h(`img.ui-ic${cls ? '.' + cls : ''}`, { src: `icons/${path}${plain ? '' : '_dark'}.svg`, width: size, height: size, alt: '', draggable: false });
  if (!plain) img.addEventListener('error', () => { if (img.dataset.fb) return; img.dataset.fb = '1'; img.src = `icons/${path}.svg`; });
  return img;
}
