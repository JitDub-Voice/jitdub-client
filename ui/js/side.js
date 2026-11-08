// Правая панель: инспектор выделенного (реплика / клип / дорожка) и вкладки «Участники», «Чат», «Дубли».
import { h, fill, fmtTime, parseTime, charColor, avatar, gainToDb, dbToGain, timeAgo, fmtBytes, uid } from './util.js';
import { icon } from './icons.js';
import { doc, events as docEvents, canEdit, member, update, batch, chat, byKind, tracks } from './sync.js';
import * as audio from './audio.js';
import { ui, uiEvents, select, selected, arm } from './ui.js';
import { menu, toast, confirm, select as dd } from './kit.js';
import { api, session } from './api.js';
import { allCharacterNames } from './script.js';

let el = {};
let tab = 'people';
let unread = 0;

export function mountSide(inspEl, tabsEl, bodyEl) {
  el.insp = inspEl; el.tabs = tabsEl; el.body = bodyEl;
  renderInspector();
  renderTabs();
  renderBody();
  uiEvents.on('select', renderInspector);
  docEvents.on('state', () => { renderInspector(); renderTabs(); renderBody(); });
  docEvents.on('change', ch => {
    if ([...ch.ids].some(id => ui.sel.has(id)) || ch.removed.size) renderInspectorSoft();
    if (tab === 'takes' && ch.kinds.has('clip')) renderBody();
  });
  docEvents.on('online', () => tab === 'people' && renderBody());
  docEvents.on('members', () => tab === 'people' && renderBody());
  docEvents.on('presence', () => tab === 'people' && renderPeopleSoft());
  docEvents.on('takes', () => { renderTabs(); if (tab === 'takes') renderBody(); });
  docEvents.on('chat', m => {
    if (tab === 'chat') appendMsg(m, true);
    else if (m.userId !== doc.you?.id) { unread++; renderTabs(); }
  });
}

// не перерисовываем инспектор, пока пользователь печатает в нём
function renderInspectorSoft() {
  if (el.insp.contains(document.activeElement) && document.activeElement.matches('input,textarea')) return;
  renderInspector();
}

function field(label, control, cls = '') {
  return h(`div.f${cls}`, {}, h('label', { title: label }, label), h('div.v', {}, control));
}

function timeInput(value, onSet) {
  const i = h('input', { type: 'text', value: fmtTime(value), spellcheck: false, disabled: !canEdit() });
  i.addEventListener('change', () => {
    const t = parseTime(i.value);
    if (Number.isFinite(t) && t >= 0) onSet(Math.round(t * 1000) / 1000);
    else i.value = fmtTime(value);
  });
  i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); });
  return i;
}

function textInput(value, onSet, { placeholder = '', list = null } = {}) {
  const i = h('input', { type: 'text', value: value || '', placeholder, spellcheck: false, disabled: !canEdit() });
  if (list) {
    const id = 'dl' + Math.random().toString(36).slice(2);
    i.setAttribute('list', id);
    i._dl = h('datalist', { id }, list.map(v => h('option', { value: v })));
  }
  i.addEventListener('change', () => onSet(i.value.trim()));
  i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); });
  return list ? [i, i._dl] : i;
}

function renderInspector() {
  const items = selected();
  if (!items.length) {
    fill(el.insp, h('div.ih', {}, 'Свойства'), h('div.none', {},
      'Выберите реплику, клип или дорожку.', h('br'),
      h('span', {}, 'Пробел — играть, R — запись на свою дорожку, Shift+R — записать выбранную реплику.')));
    return;
  }
  if (items.length > 1) {
    const kinds = new Set(items.map(i => i.kind));
    fill(el.insp, h('div.ih', {}, `Выбрано: ${items.length}`), h('div.acts', {},
      kinds.has('cue') && kinds.size === 1 ? statusButtons(items) : null,
      h('button.ui-btn.secondary', { disabled: !canEdit() || kinds.has('track'), onclick: () => { batch(items.map(i => ({ type: 'remove', id: i.id }))); select([]); } }, icon('delete'), 'Удалить')));
    return;
  }
  const it = items[0];
  if (it.kind === 'cue') return cueInspector(it);
  if (it.kind === 'clip') return clipInspector(it);
  if (it.kind === 'track') return trackInspector(it);
  if (it.kind === 'marker') return markerInspector(it);
}

function statusButtons(items) {
  const set = s => batch(items.map(i => ({ type: 'update', id: i.id, data: { status: s } })));
  return h('div.ui-seg', {}, [['todo', 'Не записана'], ['recorded', 'Записана'], ['approved', 'Принята'], ['redo', 'Переписать']].map(([s, l]) =>
    h(`button${items.every(i => (i.status || 'todo') === s) ? '.on' : ''}`, { onclick: () => set(s), disabled: !canEdit() }, h(`span.st.${s}`, {}, h('i')), l)));
}

function cueInspector(q) {
  const people = [...doc.members.values()];
  const txt = h('textarea', { rows: 3, value: q.text, disabled: !canEdit() });
  txt.addEventListener('change', () => update(q.id, { text: txt.value }));
  const note = h('textarea', { rows: 2, value: q.note || '', placeholder: 'интонация, подсказки режиссёра…', disabled: !canEdit() });
  note.addEventListener('change', () => update(q.id, { note: note.value }));
  const assignee = dd(q.assigneeId ?? null, [{ value: null, label: 'никто' }, ...people.map(p => ({ value: p.id, label: p.displayName, color: p.color }))], v => update(q.id, { assigneeId: v }));
  assignee.disabled = !canEdit();
  const takes = byKind('clip').filter(c => c.cueId === q.id);
  fill(el.insp,
    h('div.ih', {}, h('i.mdot', { style: { background: charColor(q.character) } }), 'Реплика', h('span.dim', {}, `${(q.end - q.start).toFixed(2)} с`)),
    field('Начало', timeInput(q.start, v => update(q.id, { start: v, end: Math.max(v + 0.05, q.end) }))),
    field('Конец', timeInput(q.end, v => update(q.id, { end: Math.max(q.start + 0.05, v) }))),
    field('Персонаж', textInput(q.character, v => update(q.id, { character: v }), { placeholder: 'имя персонажа', list: allCharacterNames() })),
    field('Озвучивает', assignee),
    field('Текст', txt, '.top'),
    field('Заметка', note, '.top'),
    h('div.acts', {}, statusButtons([q])),
    h('div.acts', {},
      h('button.ui-btn.primary', { onclick: () => window.dispatchEvent(new CustomEvent('jitdub:recordCue', { detail: q.id })), disabled: !canEdit() }, icon('mic'), 'Записать'),
      h('button.ui-btn.secondary', { onclick: () => { audio.seek(Math.max(0, q.start - 0.5)); audio.play(); } }, icon('play'), 'Прослушать'),
      takes.length ? h('span.dim', { style: { alignSelf: 'center', fontSize: '12px' } }, `дублей: ${takes.length}`) : null));
}

function clipInspector(c) {
  const take = doc.takes.get(c.takeId);
  const author = member(take?.userId);
  const tr = tracks().find(t => t.id === c.trackId);
  const g = c.gain ?? 1;
  const gainR = h('input', { type: 'range', min: -30, max: 12, step: 0.5, value: gainToDb(g), disabled: !canEdit() });
  const gainL = h('span.dim', { style: { width: '52px', textAlign: 'right', fontSize: '12px' } }, `${gainToDb(g).toFixed(1)} дБ`);
  gainR.addEventListener('input', () => { gainL.textContent = `${(+gainR.value).toFixed(1)} дБ`; });
  gainR.addEventListener('change', () => update(c.id, { gain: Math.round(dbToGain(+gainR.value) * 1000) / 1000 }));
  gainR.addEventListener('dblclick', () => update(c.id, { gain: 1 }));
  const num = (v, key, max) => {
    const i = h('input', { type: 'number', min: 0, max, step: 0.05, value: (v || 0).toFixed(2), disabled: !canEdit() });
    i.addEventListener('change', () => update(c.id, { [key]: Math.max(0, Math.min(max, +i.value || 0)) }));
    return i;
  };
  const cue = c.cueId ? doc.items.get(c.cueId) : null;
  fill(el.insp,
    h('div.ih', {}, h('i.mdot', { style: { background: tr?.color || '#3574F0' } }), 'Клип', h('span.dim', {}, tr?.name || '')),
    field('Начало', timeInput(c.start, v => update(c.id, { start: v }))),
    field('Длина', h('span', {}, `${c.duration.toFixed(2)} с`)),
    field('Громкость', [gainR, gainL]),
    field('Фейд вход', [num(c.fadeIn, 'fadeIn', c.duration / 2), h('span.dim', {}, 'с')]),
    field('Фейд выход', [num(c.fadeOut, 'fadeOut', c.duration / 2), h('span.dim', {}, 'с')]),
    field('Название', textInput(c.name, v => update(c.id, { name: v }), { placeholder: take?.name || 'дубль' })),
    field('Дубль', h('span.dim', { style: { fontSize: '12px' } }, `${author?.displayName || '?'} · ${take ? timeAgo(take.createdAt) : ''} · ${take ? fmtBytes(take.size) : ''}`)),
    cue ? field('Реплика', h('a', { onclick: () => select(cue.id) }, (cue.character ? cue.character + ': ' : '') + cue.text.slice(0, 40))) : null,
    h('div.acts', {},
      h('button.ui-btn.secondary', { disabled: !canEdit(), onclick: () => update(c.id, { mute: !c.mute }) }, icon(c.mute ? 'show' : 'hide'), c.mute ? 'Включить' : 'Заглушить'),
      h('button.ui-btn.secondary', { disabled: !canEdit(), onclick: () => { batch([{ type: 'remove', id: c.id }]); select([]); } }, icon('delete'), 'Удалить')));
}

const SWATCHES = ['#3574F0', '#5FAD65', '#E08855', '#955AE0', '#24A394', '#DB5C5C', '#F2C55C', '#E06AA8', '#4FB3D9', '#A3C44E'];

function trackInspector(t) {
  const people = [...doc.members.values()];
  const owner = dd(t.ownerId ?? null, [{ value: null, label: 'общая' }, ...people.map(p => ({ value: p.id, label: p.displayName, color: p.color }))], v => update(t.id, { ownerId: v }));
  owner.disabled = !canEdit();
  const pan = h('input', { type: 'range', min: -1, max: 1, step: 0.05, value: t.pan ?? 0, disabled: !canEdit() });
  pan.addEventListener('change', () => update(t.id, { pan: +pan.value }));
  pan.addEventListener('dblclick', () => update(t.id, { pan: 0 }));
  const lock = h('input', { type: 'checkbox', checked: !!t.locked, disabled: !canEdit() });
  lock.addEventListener('change', () => update(t.id, { locked: lock.checked }));
  const n = byKind('clip').filter(c => c.trackId === t.id).length;
  fill(el.insp,
    h('div.ih', {}, h('i.mdot', { style: { background: t.color } }), 'Дорожка', h('span.dim', {}, `${n} клип.`)),
    field('Название', textInput(t.name, v => v && update(t.id, { name: v }))),
    field('Персонаж', textInput(t.character, v => update(t.id, { character: v }), { placeholder: 'кого озвучивает', list: allCharacterNames() })),
    field('Владелец', owner),
    field('Цвет', h('div.swatches', {}, SWATCHES.map(c => h(`i${c === t.color ? '.on' : ''}`, { style: { background: c }, onclick: () => canEdit() && update(t.id, { color: c }) })))),
    field('Панорама', pan),
    field('Блокировка', h('label.row', {}, lock, h('span.dim', { style: { fontSize: '12px' } }, 'другим не писать сюда'))),
    h('div.acts', {}, h('button.ui-btn.secondary', { onclick: () => arm(t.id) }, icon('mic'), ui.armed === t.id ? 'Запись сюда ✓' : 'Писать сюда')));
}

function markerInspector(m) {
  fill(el.insp,
    h('div.ih', {}, h('i.mdot', { style: { background: m.color } }), 'Маркер'),
    field('Время', timeInput(m.time, v => update(m.id, { time: v }))),
    field('Подпись', textInput(m.label, v => update(m.id, { label: v }))),
    h('div.acts', {}, h('button.ui-btn.secondary', { disabled: !canEdit(), onclick: () => { batch([{ type: 'remove', id: m.id }]); select([]); } }, icon('delete'), 'Удалить')));
}

// ---------- вкладки ----------
function renderTabs() {
  const online = new Set([...doc.online.values()].map(o => o.userId)).size;
  const t = (id, label, ic, n, hot) => h(`div.tab${tab === id ? '.on' : ''}`, { onclick: () => { tab = id; if (id === 'chat') unread = 0; renderTabs(); renderBody(); } },
    icon(ic, { size: 14 }), label, n ? h(`span.n${hot ? '.hot' : ''}`, {}, n) : null);
  fill(el.tabs,
    t('people', 'Участники', 'users', online ? `${online}/${doc.members.size}` : null),
    t('chat', 'Чат', 'chat', unread || null, true),
    t('takes', 'Дубли', 'mic', doc.takes.size || null));
}

function renderBody() {
  if (tab === 'people') renderPeople();
  else if (tab === 'chat') renderChat();
  else renderTakes();
}

function renderPeople() {
  const onlineBy = new Map();
  for (const o of doc.online.values()) onlineBy.set(o.userId, o);
  const isOwner = doc.you?.role === 'owner';
  const people = [...doc.members.values()].sort((a, b) => (onlineBy.has(b.id) - onlineBy.has(a.id)) || a.displayName.localeCompare(b.displayName));
  el.peopleList = h('div.people', {}, people.map(p => personRow(p, onlineBy.get(p.id), isOwner)));
  fill(el.body,
    isOwner || doc.project?.inviteCode ? h('div.invite', {},
      h('span.dim', { style: { fontSize: '12px' } }, 'Код приглашения — отправьте актёрам'),
      h('div.row', {},
        h('span.code', {}, doc.project?.inviteCode || '—'),
        h('span.grow'),
        h('button.ui-ib', { 'data-tip': 'Скопировать', onclick: () => { navigator.clipboard.writeText(doc.project.inviteCode); toast('Код скопирован', 'ok', 1500); } }, icon('copy')),
        isOwner ? h('button.ui-ib', { 'data-tip': 'Новый код (старый перестанет работать)', onclick: regenInvite }, icon('refresh')) : null)) : null,
    el.peopleList);
}

function personRow(p, o, isOwner) {
  const pr = o?.presence || {};
  const status = !o ? 'не в сети' : pr.recording ? '● пишет' : pr.playing ? '▶ смотрит' : pr.playhead != null ? `на ${fmtTime(pr.playhead, false)}` : 'в сети';
  return h(`div.person${o ? '' : '.off'}`, {
    dataset: { uid: p.id },
    oncontextmenu: e => {
      if (!isOwner || p.id === doc.you.id) return;
      e.preventDefault();
      menu(e.clientX, e.clientY, [
        { label: 'Актёр (может редактировать)', icon: p.role === 'editor' ? 'check' : null, onClick: () => setRole(p, 'editor') },
        { label: 'Зритель (только смотреть)', icon: p.role === 'viewer' ? 'check' : null, onClick: () => setRole(p, 'viewer') },
        '-',
        { label: 'Исключить из проекта', icon: 'exit', danger: true, onClick: () => kick(p) },
      ]);
    },
    ondblclick: () => { if (pr.playhead != null) audio.seek(pr.playhead); },
    title: pr.playhead != null ? 'Двойной клик — перейти к позиции участника' : '',
  },
    avatar(p, 24),
    h('div.nm', {}, p.displayName, p.id === doc.you?.id ? h('span.dim', {}, ' (вы)') : null, h('small', {}, status)),
    h(`span.badge.${p.role}`, {}, { owner: 'владелец', editor: 'актёр', viewer: 'зритель' }[p.role]),
    o ? h('span.ondot') : null);
}

function renderPeopleSoft() {
  if (!el.peopleList?.isConnected) return;
  const onlineBy = new Map();
  for (const o of doc.online.values()) onlineBy.set(o.userId, o);
  for (const row of el.peopleList.children) {
    const p = doc.members.get(row.dataset.uid);
    if (p) row.replaceWith(personRow(p, onlineBy.get(p.id), doc.you?.role === 'owner'));
  }
}

async function regenInvite() {
  if (!(await confirm('Новый код приглашения', 'Старый код перестанет работать. Уже вошедшие участники останутся в проекте.', { ok: 'Сменить', danger: false }))) return;
  try { const r = await api(`/api/projects/${doc.project.id}/invite`, { method: 'POST' }); doc.project.inviteCode = r.inviteCode; renderBody(); } catch (e) { toast(e.message, 'err'); }
}
async function setRole(p, role) {
  try { await api(`/api/projects/${doc.project.id}/members/${p.id}`, { method: 'PATCH', body: { role } }); } catch (e) { toast(e.message, 'err'); }
}
async function kick(p) {
  if (!(await confirm('Исключить участника?', `${p.displayName} потеряет доступ к проекту. Его дубли останутся.`, { ok: 'Исключить' }))) return;
  try { await api(`/api/projects/${doc.project.id}/members/${p.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message, 'err'); }
}

// ---------- чат ----------
function linkify(text) {
  // «01:23» в сообщении — ссылка на время
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/\b(\d{1,2}:\d{2}(?:\.\d{1,3})?)\b/g)) {
    parts.push(text.slice(last, m.index));
    const t = parseTime(m[1]);
    parts.push(h('a.tc', { onclick: () => audio.seek(t) }, m[1]));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function msgEl(m) {
  const u = member(m.userId) || { displayName: '?', color: '#5A5D63' };
  return h('div.msg', {}, avatar(u, 22), h('div', {},
    h('div.who', {}, u.displayName, h('span', {}, new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))),
    h('div.tx', {}, linkify(m.text))));
}

function appendMsg(m, scroll) {
  if (!el.msgs?.isConnected) return;
  el.msgs.append(msgEl(m));
  if (scroll) el.msgs.scrollTop = el.msgs.scrollHeight;
}

function renderChat() {
  el.msgs = h('div.msgs', {}, doc.messages.length ? doc.messages.map(msgEl) : h('div.dim', { style: { padding: '10px', fontSize: '12px' } }, 'Сообщений пока нет. Время вида 01:23 в сообщении становится ссылкой на этот момент.'));
  const inp = h('input', { type: 'text', placeholder: 'Сообщение… (Ctrl+T — вставить время плейхеда)', spellcheck: true });
  const sendIt = () => {
    const t = inp.value.trim();
    if (!t) return;
    if (!chat(t)) return toast('Нет соединения', 'err');
    inp.value = '';
  };
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendIt(); }
    if (e.key === 't' && e.ctrlKey) { e.preventDefault(); inp.setRangeText(fmtTime(audio.position()).slice(0, -2) + ' ', inp.selectionStart, inp.selectionEnd, 'end'); }
  });
  fill(el.body, h('div.chat', {}, el.msgs, h('div.inp', {}, inp, h('button.ui-btn.primary', { onclick: sendIt }, 'Отпр.'))));
  el.msgs.scrollTop = el.msgs.scrollHeight;
  setTimeout(() => inp.focus(), 20);
}

// ---------- дубли ----------
function renderTakes() {
  const used = new Set(byKind('clip').map(c => c.takeId));
  const list = [...doc.takes.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!list.length) { fill(el.body, h('div.empty', { style: { margin: '10px', minHeight: '140px' } }, 'Записанные дубли появятся здесь. Перетащите дубль на дорожку, чтобы вставить его снова.')); return; }
  fill(el.body, h('div.takes', {}, list.map(t => {
    const u = member(t.userId) || { displayName: '?', color: '#5A5D63' };
    return h(`div.take${used.has(t.id) ? '' : '.unused'}`, {
      draggable: true,
      ondragstart: e => { e.dataTransfer.setData('application/x-jitdub-take', t.id); e.dataTransfer.effectAllowed = 'copy'; },
      ondblclick: () => previewTake(t),
      oncontextmenu: e => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [
          { label: 'Прослушать', icon: 'play', onClick: () => previewTake(t) },
          { label: 'Вставить на мою дорожку у плейхеда', icon: 'add', disabled: !canEdit(), onClick: () => insertTake(t) },
          '-',
          { label: 'Удалить дубль', icon: 'delete', danger: true, disabled: used.has(t.id) || (t.userId !== doc.you.id && doc.you.role !== 'owner'), onClick: () => deleteTake(t) },
        ]);
      },
    },
      avatar(u, 22),
      h('div.nm', {}, t.name || `Дубль ${u.displayName}`, h('small', {}, `${t.duration.toFixed(1)} с · ${timeAgo(t.createdAt)}${used.has(t.id) ? '' : ' · не на таймлайне'}`)),
      h('button.ui-ib', { 'data-tip': 'Прослушать', onclick: () => previewTake(t) }, icon('play')));
  })));
}

let preview = null;
async function previewTake(t) {
  try {
    preview?.stop();
    const { buffer } = await audio.loadTake(t.id);
    const c = audio.audioCtx();
    const s = c.createBufferSource();
    s.buffer = buffer;
    s.connect(c.destination);
    s.start();
    preview = s;
  } catch (e) { toast(e.message, 'err'); }
}

function insertTake(t) {
  const trackId = ui.armed || tracks()[0]?.id;
  if (!trackId) return;
  const id = uid('k');
  batch([{ type: 'add', kind: 'clip', id, data: { trackId, takeId: t.id, start: audio.position(), offset: 0, duration: t.duration, gain: 1, fadeIn: 0, fadeOut: 0, name: t.name || '', cueId: null, mute: false } }], { label: 'клип' });
  select(id);
}

async function deleteTake(t) {
  if (!(await confirm('Удалить дубль?', 'Аудио будет удалено с сервера у всех участников.'))) return;
  try { await api(`/api/takes/${t.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message, 'err'); }
}

export { session };
