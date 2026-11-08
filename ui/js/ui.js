// Локальное состояние интерфейса: выделение, «вооружённая» под запись дорожка, привязка, следование за плейхедом.
import { Emitter } from './util.js';
import { prefs } from './api.js';
import { doc, tracks, presence } from './sync.js';

export const uiEvents = new Emitter();

export const ui = {
  sel: new Set(),
  armed: null,                       // id дорожки, на которую пишем
  snap: prefs.get('snap', true),
  follow: prefs.get('follow', true),
};

export function select(ids, { add = false, toggle = false } = {}) {
  ids = [].concat(ids || []).filter(Boolean);
  if (!add && !toggle) ui.sel.clear();
  for (const id of ids) {
    if (toggle && ui.sel.has(id)) ui.sel.delete(id);
    else ui.sel.add(id);
  }
  presence({ selection: [...ui.sel] });
  uiEvents.emit('select');
}

export const selected = () => [...ui.sel].map(id => doc.items.get(id)).filter(Boolean);

// убрать из выделения удалённые объекты
export function pruneSelection() {
  let changed = false;
  for (const id of ui.sel) if (!doc.items.has(id)) { ui.sel.delete(id); changed = true; }
  if (changed) uiEvents.emit('select');
}

export function arm(trackId) {
  ui.armed = trackId;
  presence({ trackId });
  uiEvents.emit('arm');
}

// Дорожка по умолчанию для записи: своя, иначе первая незаблокированная
export function ensureArmed() {
  const all = tracks();
  if (ui.armed && all.some(t => t.id === ui.armed)) return ui.armed;
  const mine = all.find(t => t.ownerId === doc.you?.id) || all.find(t => !t.locked) || all[0];
  ui.armed = mine?.id || null;
  uiEvents.emit('arm');
  return ui.armed;
}

export function setSnap(v) { ui.snap = v; prefs.set('snap', v); uiEvents.emit('view'); }
export function setFollow(v) { ui.follow = v; prefs.set('follow', v); uiEvents.emit('view'); }
