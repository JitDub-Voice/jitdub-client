// Левая панель: сценарий (список реплик с фильтрами и импортом субтитров) и персонажи (кто кого озвучивает).
import { h, fill, fmtTime, charColor, avatar, uid, debounce } from './util.js';
import { icon } from './icons.js';
import { doc, events as docEvents, cues, batch, canEdit, member, update } from './sync.js';
import * as audio from './audio.js';
import { ui, uiEvents, select } from './ui.js';
import { editCueText, addCueAt, scrollToTime } from './timeline.js';
import { parseSubs } from './subs.js';
import { menu, toast, confirm, select as dd } from './kit.js';

let el = {};
let tab = 'script';
let filter = { q: '', mine: false, status: 'all' };

const STATUS = { todo: 'не записана', recorded: 'записана', approved: 'принята', redo: 'переписать' };

export function mountScript(tabsEl, bodyEl) {
  el.tabs = tabsEl; el.body = bodyEl;
  el.file = h('input', { type: 'file', accept: '.srt,.ass,.ssa,.vtt', style: { display: 'none' }, onchange: () => el.file.files[0] && importSubs(el.file.files[0]) });
  document.body.append(el.file);
  renderTabs();
  render();
  docEvents.on('state', () => { renderTabs(); render(); });
  docEvents.on('change', ch => { if (ch.kinds.has('cue') || ch.kinds.has('track')) { renderTabs(); renderList(); } });
  docEvents.on('members', render);
  const relist = debounce(renderList, 150);
  docEvents.on('presence', (o, changed) => { if (changed?.has('selection')) relist(); }); // аватарки «кто смотрит реплику»
  uiEvents.on('select', renderList);
  audio.events.on('tick', markNow);
  audio.events.on('seek', markNow);
  window.addEventListener('jitdub:importSubs', e => importSubs(e.detail));
}

export const pickSubs = () => { el.file.value = ''; el.file.click(); };

function renderTabs() {
  const all = cues();
  const done = all.filter(q => q.status === 'recorded' || q.status === 'approved').length;
  const t = (id, label, ic, n) => h(`div.tab${tab === id ? '.on' : ''}`, { onclick: () => { tab = id; renderTabs(); render(); } }, icon(ic, { size: 14 }), label, n != null ? h('span.n', {}, n) : null);
  fill(el.tabs,
    t('script', 'Сценарий', 'script', all.length ? `${done}/${all.length}` : null),
    t('chars', 'Персонажи', 'users', characters().length || null),
    h('span.grow'),
    h('button.ui-ib', { 'data-tip': 'Импорт субтитров (.ass, .srt, .vtt)', onclick: pickSubs, disabled: !canEdit() }, icon('import')));
}

function render() {
  if (tab === 'script') renderScript(); else renderChars();
}

// ---------- сценарий ----------
function renderScript() {
  const search = h('input', { type: 'text', placeholder: 'Поиск по тексту и персонажам', value: filter.q, spellcheck: false });
  search.addEventListener('input', debounce(() => { filter.q = search.value.trim().toLowerCase(); renderList(); }, 120));
  const wrapSearch = h('div.ui-search', {}, icon('search'), search);
  const mineBtn = h(`button.ui-ib${filter.mine ? '.on' : ''}`, { 'data-tip': 'Только мои реплики', onclick: () => { filter.mine = !filter.mine; render(); } }, icon('user'));
  const stBtn = h(`button.ui-ib${filter.status !== 'all' ? '.on' : ''}`, {
    'data-tip': 'Фильтр по статусу',
    onclick: e => menu(e.clientX, e.clientY, ['all', 'todo', 'recorded', 'approved', 'redo'].map(s => ({
      label: s === 'all' ? 'Все' : STATUS[s], icon: filter.status === s ? 'check' : null, onClick: () => { filter.status = s; render(); },
    }))),
  }, icon('filter'));
  const addBtn = h('button.ui-ib', { 'data-tip': 'Реплика на плейхеде', disabled: !canEdit(), onclick: () => addCueAt(audio.position()) }, icon('add'));
  el.list = h('div.cues');
  fill(el.body, h('div.pbar', {}, wrapSearch, mineBtn, stBtn, addBtn), el.list);
  renderList();
}

function visibleCues() {
  const me = doc.you?.id;
  return cues().filter(q => {
    if (filter.mine && q.assigneeId !== me) return false;
    if (filter.status !== 'all' && (q.status || 'todo') !== filter.status) return false;
    if (filter.q && !(`${q.text} ${q.character}`.toLowerCase().includes(filter.q))) return false;
    return true;
  });
}

function renderList() {
  if (tab !== 'script' || !el.list) return;
  const list = visibleCues();
  if (!cues().length) {
    fill(el.list, h('div.empty', { style: { margin: '10px', minHeight: '200px' } },
      icon('script', { size: 28 }),
      h('b', {}, 'Реплик пока нет'),
      h('span', {}, 'Импортируйте субтитры серии — каждая строка станет репликой, поле Name/Actor из .ass — персонажем.'),
      h('div.row', {},
        h('button.ui-btn.primary.slim', { onclick: pickSubs, disabled: !canEdit() }, icon('import'), 'Импорт субтитров'),
        h('button.ui-btn.secondary.slim', { onclick: () => addCueAt(audio.position()), disabled: !canEdit() }, 'Добавить вручную'))));
    return;
  }
  if (!list.length) { fill(el.list, h('div.empty', { style: { margin: '10px', minHeight: '120px' } }, 'Ничего не найдено')); return; }
  // кто из других участников сейчас выделил реплику
  const others = new Map();
  for (const o of doc.online.values()) {
    if (o.sid === doc.you?.sid) continue;
    for (const id of o.presence?.selection || []) { if (!others.has(id)) others.set(id, []); others.get(id).push(member(o.userId)); }
  }
  fill(el.list, list.map(q => {
    const ass = member(q.assigneeId);
    const row = h(`div.cue${ui.sel.has(q.id) ? '.sel' : ''}`, {
      dataset: { id: q.id },
      style: { '--cc': charColor(q.character) },
      onclick: e => {
        select(q.id, { toggle: e.ctrlKey || e.shiftKey });
        if (!audio.recording()) { audio.seek(q.start); scrollToTime(q.start); }
      },
      ondblclick: () => editCueText(q),
      oncontextmenu: e => { e.preventDefault(); if (!ui.sel.has(q.id)) select(q.id); cueRowMenu(q, e.clientX, e.clientY); },
    },
      h('div.cb'),
      h('div.tm', {}, fmtTime(q.start).slice(0, -2)),
      h('div.bd', {}, q.character ? h('div.ch', {}, q.character) : null, h('div.tx', {}, q.text || h('span.dim', {}, '(пусто)'))),
      h('div.side', {},
        h(`span.st.${q.status || 'todo'}`, { title: STATUS[q.status || 'todo'] }, h('i')),
        ass ? avatar(ass, 18) : null,
        others.get(q.id) ? h('div.others', {}, others.get(q.id).filter(Boolean).map(u => avatar(u, 14))) : null));
    return row;
  }));
  markNow(audio.position());
}

function cueRowMenu(q, x, y) {
  const ids = [...ui.sel].filter(id => doc.items.get(id)?.kind === 'cue');
  const setAll = data => batch(ids.map(id => ({ type: 'update', id, data })));
  const people = [...doc.members.values()];
  menu(x, y, [
    { label: 'Записать реплику', icon: 'mic', sc: 'Shift+R', onClick: () => window.dispatchEvent(new CustomEvent('jitdub:recordCue', { detail: q.id })) },
    { label: 'Изменить текст', icon: 'edit', disabled: !canEdit(), onClick: () => editCueText(q) },
    '-',
    ...Object.entries(STATUS).map(([s, label]) => ({ label: `Статус: ${label}`, icon: q.status === s ? 'check' : null, disabled: !canEdit(), onClick: () => setAll({ status: s }) })),
    '-',
    { label: 'Озвучиваю я', icon: 'user', disabled: !canEdit(), onClick: () => setAll({ assigneeId: doc.you.id }) },
    ...people.filter(p => p.id !== doc.you.id).slice(0, 8).map(p => ({ label: `Отдать: ${p.displayName}`, dot: p.color, disabled: !canEdit(), onClick: () => setAll({ assigneeId: p.id }) })),
    { label: 'Снять исполнителя', disabled: !canEdit(), onClick: () => setAll({ assigneeId: null }) },
    '-',
    { label: ids.length > 1 ? `Удалить (${ids.length})` : 'Удалить', icon: 'delete', danger: true, disabled: !canEdit(), onClick: () => { batch(ids.map(id => ({ type: 'remove', id }))); select([]); } },
  ]);
}

let nowId = null;
function markNow(t) {
  if (!el.list) return;
  let cur = null;
  for (const q of cues()) { if (q.start <= t && q.end > t) { cur = q.id; break; } }
  if (cur === nowId && el.list.querySelector('.cue.now')?.dataset.id === cur) return;
  nowId = cur;
  el.list.querySelectorAll('.cue.now').forEach(e => e.classList.remove('now'));
  if (!cur) return;
  const row = el.list.querySelector(`.cue[data-id="${cur}"]`);
  if (!row) return;
  row.classList.add('now');
  if (audio.isPlaying()) {
    const r = row.getBoundingClientRect(), lr = el.list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) row.scrollIntoView({ block: 'center' });
  }
}

// ---------- импорт субтитров ----------
async function importSubs(f) {
  if (!canEdit()) return toast('Только просмотр', 'warn');
  const text = await f.text();
  const parsed = parseSubs(f.name, text);
  if (!parsed.length) return toast(`В «${f.name}» не нашлось реплик`, 'warn');
  const existing = cues();
  let replace = false;
  if (existing.length) {
    replace = await confirm('Импорт субтитров', `В проекте уже ${existing.length} реплик. Заменить их на ${parsed.length} из «${f.name}»? (Отмена — добавить к существующим.)`, { ok: 'Заменить', danger: true });
  }
  const ops = [];
  if (replace) for (const q of existing) ops.push({ type: 'remove', id: q.id });
  // персонаж → исполнитель, если он уже назначен на этого персонажа
  const assign = new Map();
  for (const q of existing) if (q.character && q.assigneeId) assign.set(q.character, q.assigneeId);
  for (const c of parsed) {
    ops.push({ type: 'add', kind: 'cue', id: uid('q'), data: { start: c.start, end: c.end, text: c.text, character: c.character, status: 'todo', assigneeId: assign.get(c.character) || null } });
  }
  for (let i = 0; i < ops.length; i += 1500) batch(ops.slice(i, i + 1500), { label: 'импорт субтитров' });
  toast(`Импортировано реплик: ${parsed.length}`, 'ok');
  tab = 'script';
  renderTabs(); render();
}

// ---------- персонажи ----------
export function characters() {
  const map = new Map();
  for (const q of cues()) {
    const k = q.character || '';
    if (!map.has(k)) map.set(k, { name: k, total: 0, done: 0, assignees: new Map() });
    const c = map.get(k);
    c.total++;
    if (q.status === 'recorded' || q.status === 'approved') c.done++;
    if (q.assigneeId) c.assignees.set(q.assigneeId, (c.assignees.get(q.assigneeId) || 0) + 1);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function renderChars() {
  const list = characters();
  if (!list.length) { fill(el.body, h('div.empty', { style: { margin: '10px' } }, 'Персонажи появятся после импорта субтитров или когда вы укажете их у реплик.')); return; }
  const people = [...doc.members.values()];
  const opts = [{ value: null, label: 'никто' }, ...people.map(p => ({ value: p.id, label: p.displayName, color: p.color }))];
  fill(el.body, h('div.chars', {},
    h('div.dim', { style: { fontSize: '12px', padding: '2px 4px 6px', lineHeight: '16px' } }, 'Назначьте актёра на персонажа — все его реплики попадут в «Мои реплики» и в ленту ритмо у этого актёра.'),
    list.map(c => {
      const main = [...c.assignees.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const pick = dd(main, opts, v => {
        const ops = cues().filter(q => (q.character || '') === c.name).map(q => ({ type: 'update', id: q.id, data: { assigneeId: v } }));
        batch(ops, { label: 'назначение персонажа' });
      }, { width: '140px' });
      pick.disabled = !canEdit();
      return h('div.charrow', {},
        h('i.mdot', { style: { background: charColor(c.name), width: '10px', height: '10px' } }),
        h('b', { title: c.name || 'без имени' }, c.name || h('span.dim', {}, 'без персонажа')),
        h('span.dim', { style: { fontSize: '11px' } }, `${c.done}/${c.total}`),
        pick,
        h('div.progress', {}, h('i', { style: { width: (c.total ? (c.done / c.total) * 100 : 0) + '%' } })));
    })));
}

// персонаж на дорожке (для подсказок в инспекторе)
export const allCharacterNames = () => characters().map(c => c.name).filter(Boolean);
export { update };
