// JitDub — точка входа: экраны (лобби / студия), шапка с транспортом, запись и загрузка дублей,
// экспорт сведения, настройки, горячие клавиши, сплиттеры панелей, строка состояния.
import { h, fill, fmtTime, parseTime, avatar, uid, clamp } from './util.js';
import { icon } from './icons.js';
import { api, session, prefs, saveBytes, pickFolder, writeFile, isTauri, reveal } from './api.js';
import * as sync from './sync.js';
import { doc, events as docEvents, cues, tracks, byKind, canEdit, member } from './sync.js';
import * as audio from './audio.js';
import { ui, uiEvents, select, ensureArmed, arm } from './ui.js';
import { showAuth, showProjects } from './lobby.js';
import { mountTimeline, deleteSelection, splitAtPlayhead, addMarker, setPps, scrollToTime, refresh as refreshTimeline, copySelection, cutSelection, pasteClipboard, duplicateSelection, selectAll, nudgeSelection, zoomToSelection } from './timeline.js';
import { mountVideo, pickVideo, countdown } from './video.js';
import { mountScript, pickSubs } from './script.js';
import { mountSide } from './side.js';
import { appVersion, checkForUpdates, startUpdateChecks, updateAvailable } from './updater.js';
import { menu, menuAt, modal, prompt, toast, confirm, select as dd } from './kit.js';

const $ = id => document.getElementById(id);
let screen = null;
let mounted = false;

// ---------- экраны ----------
function setScreen(s) {
  screen = s;
  document.body.classList.toggle('s-lobby', s !== 'studio');
  document.body.classList.toggle('s-studio', s === 'studio');
  renderHeader();
  renderStatus();
}

async function boot() {
  applySplits();
  window.addEventListener('jitdub:unauthorized', () => logout('Сессия истекла — войдите снова'));
  if (!session.token) return goAuth();
  try {
    const { user } = await api('/api/me');
    session.user = user;
    goLobby();
  } catch (e) {
    if (e.status === 401) return goAuth();
    // сервер недоступен — покажем лобби с ошибкой и кнопкой «повторить»
    goLobby();
  }
}

function goAuth() {
  sync.disconnect();
  setScreen('auth');
  showAuth(() => goLobby());
}

function goLobby() {
  sync.disconnect();
  audio.pause();
  audio.closeInput();
  setScreen('lobby');
  document.title = 'JitDub';
  showProjects({ onOpen: openProject });
}

function logout(msg) {
  session.token = null;
  session.user = null;
  if (msg) toast(msg, 'warn');
  goAuth();
}

let firstState = false;
function openProject(id) {
  if (!mounted) mountStudio();
  firstState = true;
  select([]);
  ui.armed = null;
  audio.seek(0);
  setScreen('studio');
  sync.connect(id);
  prefs.set('lastProject', id);
}

function mountStudio() {
  mounted = true;
  mountVideo($('p-video'));
  mountTimeline($('p-timeline'));
  mountScript($('left-tabs'), $('left-body'));
  mountSide($('inspector'), $('right-tabs'), $('right-body'));
  initSplitters();
}

// ---------- шапка ----------
const hdr = {};

function renderHeader() {
  const L = $('h-left'), C = $('h-center'), R = $('h-right');
  const user = session.user;
  const userBtn = user ? h('button.chip', { onclick: e => userMenu(e.currentTarget) }, avatar(user, 22), h('span', {}, user.displayName)) : null;
  const gear = h('button.tbtn', { 'data-tip': 'Настройки (Ctrl+,)', onclick: openSettings }, icon('settings'));
  if (screen !== 'studio') {
    fill(L, h('span.brand', {}, 'JitDub'));
    fill(C);
    fill(R, screen === 'lobby' ? gear : null, userBtn);
    return;
  }
  hdr.project = h('button.chip', { onclick: e => projectMenu(e.currentTarget) }, icon('film'), h('span', {}, doc.project?.name || '…'), icon('down'));
  hdr.undo = h('button.b', { 'data-tip': 'Отменить (Ctrl+Z)', onclick: () => sync.undo() }, icon('undo'));
  hdr.redo = h('button.b', { 'data-tip': 'Повторить (Ctrl+Shift+Z)', onclick: () => sync.redo() }, icon('redo'));
  fill(L,
    h('button.tbtn', { 'data-tip': 'К проектам', onclick: goLobby }, icon('left')),
    h('span.hsep'),
    hdr.project,
    h('div.ui-tb', {}, hdr.undo, hdr.redo));

  hdr.play = h('button', { 'data-tip': 'Играть / пауза (Пробел)', onclick: () => (audio.recording() ? audio.stopRecording() : audio.toggle()) }, icon('play'));
  hdr.rec = h('button.recb', { 'data-tip': 'Запись на дорожку (R) · Shift+R — выбранная реплика', onclick: toggleRecord }, h('span.dot'));
  hdr.time = h('span.time', { 'data-tip': 'Клик — перейти ко времени', onclick: gotoTime }, fmtTime(0));
  hdr.meter = h('div.meter.off', { 'data-tip': 'Уровень микрофона' }, h('i'));
  hdr.mic = h('button', { 'data-tip': 'Микрофон: включить вход (для индикатора и мониторинга)', onclick: toggleInput }, icon('mic'));
  hdr.loop = h('button', { 'data-tip': 'Повтор выбранных реплик (L)', onclick: toggleLoop }, icon('restart'));
  hdr.ret = h('button', {
    onclick: () => { prefs.set('returnOnStop', !prefs.get('returnOnStop', false)); updateHeader(); toast(prefs.get('returnOnStop', false) ? 'После стопа плейхед вернётся к месту старта' : 'Стоп оставляет плейхед на месте', 'info', 1800); },
  }, icon('undo'));
  hdr.transport = h('div.transport', {},
    h('button', { 'data-tip': 'В начало (Home)', onclick: () => audio.seek(0) }, icon('toStart')),
    h('button', { 'data-tip': 'Предыдущая реплика (↑)', onclick: () => jumpCue(-1) }, icon('back')),
    hdr.play,
    h('button', { 'data-tip': 'Стоп — плейхед вернётся к месту старта', onclick: () => { audio.recording() ? audio.stopRecording() : audio.stop(); } }, icon('stop')),
    hdr.rec,
    h('button', { 'data-tip': 'Следующая реплика (↓)', onclick: () => jumpCue(1) }, icon('fwd')),
    hdr.loop,
    hdr.ret,
    h('span.tsep'),
    hdr.time,
    h('span.tsep'),
    hdr.mic, hdr.meter, h('span', { style: { width: '6px' } }));
  fill(C, hdr.transport);

  hdr.online = h('div.online');
  hdr.conn = h('span.conn', { 'data-tip': 'Соединение с сервером' });
  fill(R, hdr.online, h('span', { style: { width: '6px' } }), hdr.conn, gear, userBtn);
  updateHeader();
}

function updateHeader() {
  if (screen !== 'studio' || !hdr.play) return;
  const hist = sync.history();
  hdr.undo.disabled = !hist.undo;
  hdr.redo.disabled = !hist.redo;
  fill(hdr.play, icon(audio.isPlaying() ? 'pause' : 'play'));
  const rec = !!audio.recording();
  hdr.rec.classList.toggle('on', rec);
  hdr.transport.classList.toggle('rec', rec);
  hdr.time.classList.toggle('rec', rec);
  hdr.mic.classList.toggle('on', audio.inputOpen());
  hdr.meter.classList.toggle('off', !audio.inputOpen());
  hdr.loop.classList.toggle('on', !!audio.loop());
  const ret = prefs.get('returnOnStop', false);
  hdr.ret.classList.toggle('on', ret);
  hdr.ret.dataset.tip = ret ? 'Возврат после стопа: включён — плейхед вернётся к месту старта' : 'Возврат после стопа: выключен — плейхед остаётся на месте';
  hdr.conn.className = 'conn ' + doc.status;
  hdr.conn.dataset.tip = { online: 'В сети', connecting: 'Подключение…', offline: 'Нет соединения — переподключаюсь' }[doc.status];
  const name = hdr.project?.querySelector('span');
  if (name) name.textContent = doc.project?.name || '…';
  document.title = doc.project ? `${doc.project.name} — JitDub` : 'JitDub';
  renderOnline();
}

function renderOnline() {
  if (!hdr.online) return;
  const seen = new Map();
  for (const o of doc.online.values()) if (!seen.has(o.userId) || o.presence?.recording) seen.set(o.userId, o);
  fill(hdr.online, [...seen.values()].slice(0, 8).map(o => {
    const u = member(o.userId) || { displayName: '?', color: '#5A5D63' };
    const a = avatar(u, 24);
    a.classList.toggle('rec', !!o.presence?.recording);
    a.title = `${u.displayName}${o.userId === doc.you?.id ? ' (вы)' : ''}${o.presence?.recording ? ' — пишет' : ''}${o.presence?.playhead != null ? ' · ' + fmtTime(o.presence.playhead, false) : ''}`;
    a.style.cursor = 'pointer';
    a.onclick = () => { if (o.presence?.playhead != null && o.userId !== doc.you?.id) { audio.seek(o.presence.playhead); scrollToTime(o.presence.playhead); } };
    return a;
  }));
}

function projectMenu(btn) {
  const owner = doc.you?.role === 'owner';
  menuAt(btn, [
    { label: 'Переименовать…', icon: 'edit', disabled: !canEdit(), onClick: renameProject },
    { label: 'Открыть видео…', icon: 'folder', onClick: pickVideo },
    { label: 'Импорт субтитров…', icon: 'import', disabled: !canEdit(), onClick: pickSubs },
    { label: 'Экспорт озвучки…', icon: 'export', sc: 'Ctrl+E', onClick: openExport },
    '-',
    { label: `Код приглашения: ${doc.project?.inviteCode || ''}`, icon: 'copy', onClick: () => { navigator.clipboard.writeText(doc.project.inviteCode); toast('Код скопирован', 'ok', 1500); } },
    '-',
    { label: 'Закрыть проект', icon: 'left', onClick: goLobby },
    owner ? { label: 'Удалить проект…', icon: 'delete', danger: true, onClick: deleteProject } : null,
  ]);
}

async function renameProject() {
  const name = await prompt('Название проекта', { value: doc.project.name, ok: 'Сохранить' });
  if (name) sync.op({ type: 'project', data: { name } });
}

async function deleteProject() {
  if (!(await confirm('Удалить проект?', `«${doc.project.name}» будет удалён у всех участников вместе с дублями.`))) return;
  try { await api(`/api/projects/${doc.project.id}`, { method: 'DELETE' }); goLobby(); } catch (e) { toast(e.message, 'err'); }
}

function userMenu(btn) {
  menuAt(btn, [
    { label: session.user?.username ? `@${session.user.username}` : '', disabled: true },
    { label: 'Профиль и настройки…', icon: 'settings', onClick: openSettings },
    session.user?.isAdmin ? { label: 'Ключи приглашения…', icon: 'link', onClick: openInvites } : null,
    { label: updateAvailable() ? `Обновить до ${updateAvailable().version}…` : 'Проверить обновления', icon: 'download', onClick: () => checkForUpdates({ manual: true }) },
    { label: 'Горячие клавиши', icon: 'help', sc: 'F1', onClick: showHotkeys },
    '-',
    { label: 'Выйти из аккаунта', icon: 'exit', danger: true, onClick: () => logout() },
  ]);
}

async function gotoTime() {
  const v = await prompt('Перейти ко времени', { value: fmtTime(audio.position()), placeholder: '01:23.500', ok: 'Перейти' });
  const t = parseTime(v ?? '');
  if (Number.isFinite(t)) { audio.seek(t); scrollToTime(t); }
}

// ---------- запись ----------
function canRecordOn(trackId) {
  const t = tracks().find(x => x.id === trackId);
  if (!t) { toast('Нет дорожки для записи — добавьте дорожку', 'warn'); return false; }
  if (!canEdit()) { toast('У вас права только на просмотр', 'warn'); return false; }
  if (t.locked && t.ownerId && t.ownerId !== doc.you.id) { toast(`Дорожка «${t.name}» заблокирована владельцем`, 'warn'); return false; }
  for (const o of doc.online.values()) {
    if (o.sid !== doc.you.sid && o.presence?.recording === trackId) {
      toast(`На дорожку «${t.name}» сейчас пишет ${member(o.userId)?.displayName || 'другой участник'}`, 'warn');
      return false;
    }
  }
  return true;
}

async function toggleRecord() {
  if (audio.recording()) { audio.stopRecording(); return; }
  const trackId = ensureArmed();
  if (!canRecordOn(trackId)) return;
  try {
    const preroll = Number(prefs.get('freePreroll', 0));
    await audio.startRecording({ trackId, punchIn: audio.position(), preroll });
  } catch (e) { micError(e); }
}

async function recordCue(cueId) {
  const q = cueId ? doc.items.get(cueId) : cueAt(audio.position()) || [...ui.sel].map(id => doc.items.get(id)).find(i => i?.kind === 'cue');
  if (!q || q.kind !== 'cue') { toast('Выберите реплику для записи', 'warn'); return; }
  if (audio.recording()) await audio.stopRecording();
  const trackId = ensureArmed();
  if (!canRecordOn(trackId)) return;
  select(q.id);
  try {
    await audio.startRecording({
      trackId, cueId: q.id,
      punchIn: Math.max(0, q.start - 0.3),
      autoStop: q.end + Number(prefs.get('tail', 0.6)),
      preroll: Number(prefs.get('preroll', 2)),
    });
  } catch (e) { micError(e); }
}

function micError(e) {
  const msg = e?.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён — разрешите его в системе (Параметры → Конфиденциальность → Микрофон)'
    : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'Микрофон не найден — выберите другой в настройках' : `Микрофон: ${e?.message || e}`;
  toast(msg, 'err', 7000);
}

async function toggleInput() {
  if (audio.inputOpen()) audio.closeInput();
  else { try { await audio.openInput(); } catch (e) { micError(e); } }
}

function cueAt(t) { return cues().find(q => q.start <= t && q.end > t) || null; }

// записанный дубль: загрузка на сервер, клип на дорожку, статус реплики
audio.events.on('recorded', async r => {
  const q = r.cueId ? doc.items.get(r.cueId) : null;
  const name = q ? `${q.character ? q.character + ': ' : ''}${q.text}`.slice(0, 60) : `Дубль ${doc.you?.displayName || ''}`;
  const projectId = doc.project?.id;
  const upload = async () => {
    const { take } = await api(`/api/projects/${projectId}/takes`, {
      method: 'POST', body: r.wav,
      headers: { 'content-type': 'audio/wav', 'x-duration': String(r.buffer.duration), 'x-name': encodeURIComponent(name) },
    });
    if (doc.project?.id !== projectId) return;
    doc.takes.set(take.id, take);
    audio.cacheTake(take.id, r.buffer);
    const id = uid('k');
    const a = round(r.start), b = round(r.start + r.duration);
    const replaced = byKind('clip').filter(c => c.trackId === r.trackId && !c.mute &&
      ((r.cueId && c.cueId === r.cueId) || (c.start >= a - 0.05 && c.start + c.duration <= b + 0.05)));
    sync.batch([
      ...replaced.map(c => ({ type: 'update', id: c.id, data: { mute: true } })),
      { type: 'add', kind: 'clip', id, data: { trackId: r.trackId, takeId: take.id, start: a, offset: round(r.offset), duration: round(r.duration), gain: 1, fadeIn: 0, fadeOut: 0, name: q ? name : '', cueId: r.cueId || null, mute: false } },
      q && (q.status === 'todo' || q.status === 'redo') ? { type: 'update', id: q.id, data: { status: 'recorded', assigneeId: q.assigneeId || doc.you.id } } : null,
    ], { label: 'запись' });
    select(id);
    lastClipId = id;
    toast(`Дубль записан: ${r.duration.toFixed(1)} с${replaced.length ? ` · прошлый дубль заглушён (${replaced.length})` : ''} · P — прослушать`, 'ok', 3000);
    if (prefs.get('autoReview', false)) reviewLast();
  };
  try {
    await upload();
  } catch (e) {
    // не теряем запись: повторить или сохранить на диск
    modal({
      title: 'Не удалось загрузить дубль', width: 440,
      body: h('div.p', {}, `${e.message}. Запись (${r.duration.toFixed(1)} с) пока в памяти.`),
      buttons: [
        { label: 'Сохранить WAV…', onClick: async close => { await saveBytes('jitdub-take.wav', r.wav); close(); } },
        { label: 'Повторить', primary: true, onClick: async close => { close(); try { await upload(); } catch (e2) { toast(e2.message, 'err'); } } },
      ],
    });
  }
});
const round = v => Math.round(v * 1000) / 1000;

// P — прослушать последний записанный (или выбранный) клип с секундой до и после, плейхед вернётся назад
let lastClipId = null;
function reviewLast() {
  const sel = [...ui.sel].map(id => doc.items.get(id)).find(i => i?.kind === 'clip');
  const c = sel || doc.items.get(lastClipId);
  if (!c) { toast('Нет дубля для прослушивания — выберите клип', 'info'); return; }
  const back = audio.position();
  audio.playRange(Math.max(0, c.start - 1), c.start + c.duration + 0.5, back);
}

function cycleDuck() {
  const modes = Object.keys(audio.DUCK_MODES);
  const next = modes[(modes.indexOf(audio.duckMode()) + 1) % modes.length];
  audio.setDuckMode(next);
  toast(audio.DUCK_MODES[next], 'info', 1500);
}

// обратный отсчёт во время преролла записи реплики
audio.events.on('tick', t => {
  if (hdr.time) hdr.time.textContent = fmtTime(t);
  const r = audio.recording();
  const q = r?.cueId ? doc.items.get(r.cueId) : null;
  countdown(q && t < q.start ? Math.ceil(q.start - t) : 0);
});
audio.events.on('seek', t => { if (hdr.time) hdr.time.textContent = fmtTime(t); });
audio.events.on('transport', updateHeader);
audio.events.on('record', r => { updateHeader(); if (!r) countdown(0); });
audio.events.on('input', updateHeader);
audio.events.on('meter', p => { if (hdr.meter) hdr.meter.firstChild.style.setProperty('--lv', Math.min(100, Math.sqrt(p) * 100) + '%'); });
audio.events.on('error', m => toast(m, 'err'));
audio.events.on('notice', m => toast(m, 'info', 4000));

// ---------- навигация по репликам, повтор ----------
function jumpCue(dir) {
  const list = cues();
  if (!list.length) return;
  const t = audio.position();
  let q;
  if (dir > 0) q = list.find(c => c.start > t + 0.05);
  else q = [...list].reverse().find(c => c.start < t - 0.3) || list[0];
  if (!q) return;
  select(q.id);
  audio.seek(q.start);
  scrollToTime(q.start);
}

function toggleLoop() {
  if (audio.loop()) { audio.setLoop(null); return; }
  const qs = [...ui.sel].map(id => doc.items.get(id)).filter(i => i && (i.kind === 'cue' || i.kind === 'clip'));
  if (!qs.length) { toast('Выберите реплику или клип для повтора (или Shift+протяжка по линейке)', 'info'); return; }
  const a = Math.min(...qs.map(i => i.start)), b = Math.max(...qs.map(i => i.kind === 'cue' ? i.end : i.start + i.duration));
  audio.setLoop(Math.max(0, a - 0.3), b + 0.3);
  if (!audio.isPlaying()) audio.play(Math.max(0, a - 0.3));
}

// ---------- экспорт ----------
function openExport() {
  let mode = 'mix', bits = 16, range = 'all';
  const loop = audio.loop();
  const mineTrack = tracks().find(t => t.ownerId === doc.you?.id);
  const status = h('div.dim', { style: { fontSize: '12px', minHeight: '16px' } });
  const seg = (opts, get, set) => {
    const s = h('div.ui-seg', {}, opts.map(([v, l]) => h(`button${get() === v ? '.on' : ''}`, { onclick: () => { set(v); [...s.children].forEach((b, i) => b.classList.toggle('on', opts[i][0] === v)); } }, l)));
    return s;
  };
  const m = modal({
    title: 'Экспорт озвучки', width: 520,
    body: h('div.col', {},
      h('div.f', {}, h('label', {}, 'Что'), seg([['mix', 'Сведение'], ['stems', 'По дорожкам'], ['mine', 'Моя дорожка']], () => mode, v => { mode = v; })),
      h('div.hint', {}, 'Сведение — все слышимые дорожки (с учётом M/S) в один стерео-WAV. По дорожкам — отдельный файл на каждого актёра.'),
      h('div.f', {}, h('label', {}, 'Разрядность'), seg([[16, '16 бит'], [24, '24 бит']], () => bits, v => { bits = v; })),
      h('div.f', {}, h('label', {}, 'Диапазон'), seg([['all', 'Весь проект'], ...(loop ? [['loop', `Повтор ${fmtTime(loop.a, false)}–${fmtTime(loop.b, false)}`]] : [])], () => range, v => { range = v; })),
      h('div.hint', {}, 'Начало файла совпадает с началом видео (00:00), чтобы дорожку можно было сразу положить на видео в монтажке.'),
      status),
    buttons: [
      { label: 'Отмена', value: null },
      { label: 'Экспорт', primary: true, onClick: async close => {
        try {
          const from = range === 'loop' ? loop.a : 0;
          const to = range === 'loop' ? loop.b : Math.max(doc.project?.video?.duration || 0, audio.projectEnd() - 0);
          const base = (doc.project.name || 'jitdub').replace(/[\\/:*?"<>|]+/g, '_');
          const progress = p => { status.textContent = `Подготовка дублей… ${Math.round(p * 100)}%`; };
          if (mode === 'stems') {
            const dir = isTauri ? await pickFolder() : '';
            if (isTauri && !dir) return;
            for (const t of tracks()) {
              if (!byKind('clip').some(c => c.trackId === t.id)) continue;
              status.textContent = `Свожу «${t.name}»…`;
              const wav = await audio.mixdown({ trackIds: [t.id], from, to, bits, onProgress: progress });
              const fname = `${base} - ${t.name.replace(/[\\/:*?"<>|]+/g, '_')}.wav`;
              if (isTauri) await writeFile(`${dir}\\${fname}`, wav); else await saveBytes(fname, wav);
            }
            close();
            toast('Дорожки экспортированы', 'ok');
            if (dir) reveal(dir);
          } else {
            if (mode === 'mine' && !mineTrack) { status.textContent = 'У вас нет своей дорожки'; return; }
            status.textContent = 'Свожу…';
            const wav = await audio.mixdown({ trackIds: mode === 'mine' ? [mineTrack.id] : null, from, to, bits, onProgress: progress });
            const path = await saveBytes(`${base}${mode === 'mine' ? ' - ' + mineTrack.name : ''}.wav`, wav, [['WAV', 'wav']]);
            if (!path) { status.textContent = ''; return; }
            close();
            toast(`Сохранено: ${path}`, 'ok', 5000);
          }
        } catch (e) { status.textContent = 'Ошибка: ' + e.message; }
      } },
    ],
  });
  return m;
}

// ---------- настройки ----------
// ---------- профиль: аватарка ----------
function applyProfile(user) {
  session.user = user;
  const m = doc.members.get(user.id);
  if (m) Object.assign(m, user);
  if (doc.you?.id === user.id) Object.assign(doc.you, user);
  renderHeader();
  refreshTimeline();
  docEvents.emit('members');
}

// обрезка по центру до квадрата 256×256 и сжатие в WebP прямо в клиенте
// анимированный WebP — в заголовке есть чанк ANIM
async function isAnimatedWebp(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  return new TextDecoder().decode(head).includes('ANIM');
}

async function squareImage(file, size = 256) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const cv = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = cv.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close?.();
  return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('не удалось сжать картинку'))), 'image/webp', 0.9));
}

async function uploadAvatar(file) {
  if (!file.type.startsWith('image/')) { toast('Это не картинка', 'warn'); return; }
  try {
    const animated = file.type === 'image/gif' || (file.type === 'image/webp' && await isAnimatedWebp(file));
    if (animated && file.size > 10 * 1024 * 1024) { toast('Анимированная аватарка — до 10 МБ', 'warn'); return; }
    const blob = animated ? file : await squareImage(file);
    const { user } = await api('/api/me/avatar', { method: 'PUT', body: blob, headers: { 'content-type': blob.type || 'image/webp' } });
    applyProfile(user);
    toast('Аватарка обновлена', 'ok', 1500);
  } catch (e) { toast(e.message, 'err'); }
}

async function removeAvatar() {
  try { const { user } = await api('/api/me/avatar', { method: 'DELETE' }); applyProfile(user); } catch (e) { toast(e.message, 'err'); }
}

// ---------- администратор: ключи приглашения ----------
async function openInvites() {
  const list = h('div.inv-list', {}, h('div.dim', {}, 'Загрузка…'));
  const summary = h('span.dim', { style: { fontSize: '12px' } });
  const note = h('input', { type: 'text', placeholder: 'для кого (например, Аня — Мира)', spellcheck: false });
  const uses = h('input', { type: 'number', min: 1, max: 1000, value: 1 });
  const days = h('input', { type: 'number', min: 0, max: 365, value: 7 });
  const copy = code => { navigator.clipboard.writeText(code); toast(`Ключ ${code} скопирован`, 'ok', 1500); };
  const load = async () => {
    try {
      const { invites, users } = await api('/api/admin/invites');
      const active = invites.filter(i => i.active).length;
      summary.textContent = `Пользователей: ${users} · активных ключей: ${active}`;
      fill(list, invites.length ? invites.map(i => h(`div.inv${i.active ? '' : '.off'}`, {},
        h('code', {}, i.code),
        h('div.meta', { title: i.usedBy.join(', ') },
          i.note ? h('b', {}, i.note + ' · ') : null,
          `${i.uses}/${i.maxUses}`,
          i.revoked ? ' · отозван' : i.expiresAt ? ` · до ${new Date(i.expiresAt).toLocaleDateString('ru-RU')}` : ' · бессрочно',
          i.usedBy.length ? ` · ${i.usedBy.join(', ')}` : ''),
        h('button.ui-ib', { 'data-tip': 'Скопировать', onclick: () => copy(i.code), disabled: !i.active }, icon('copy')),
        h('button.ui-ib', { 'data-tip': 'Отозвать', disabled: !i.active, onclick: async () => { try { await api(`/api/admin/invites/${i.code}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'err'); } } }, icon('delete'))))
        : h('div.dim', { style: { padding: '8px 2px' } }, 'Ключей пока нет — создайте первый.'));
    } catch (e) { fill(list, h('div.dim', {}, e.message)); }
  };
  const create = async () => {
    try {
      const { invite } = await api('/api/admin/invites', { method: 'POST', body: { note: note.value, maxUses: +uses.value || 1, expiresDays: +days.value || 0 } });
      copy(invite.code);
      note.value = '';
      load();
    } catch (e) { toast(e.message, 'err'); }
  };
  modal({
    title: 'Ключи приглашения', width: 640,
    body: h('div', {},
      h('div.dim', { style: { fontSize: '12px', lineHeight: '16px', marginBottom: '10px' } }, 'Зарегистрироваться на сервере можно только по ключу. Новый ключ сразу копируется — отправьте его актёру.'),
      h('div.inv-new', {},
        h('div', {}, h('label', {}, 'Заметка'), note),
        h('div', {}, h('label', {}, 'Регистраций'), uses),
        h('div', {}, h('label', {}, 'Дней (0 — бессрочно)'), days),
        h('button.ui-btn.primary', { onclick: create }, icon('add'), 'Создать')),
      list, h('div', { style: { marginTop: '8px' } }, summary)),
    buttons: [{ label: 'Закрыть', primary: true }],
  });
  load();
}

async function openSettings() {
  const micBox = h('div.col', { style: { gap: '6px', width: '100%' } });
  const micMeter = h('div.meter', { style: { width: '100%' } }, h('i'));
  const offMeter = audio.events.on('meter', p => { micMeter.firstChild.style.setProperty('--lv', Math.min(100, Math.sqrt(p) * 100) + '%'); });
  const renderMic = async (detect = false) => {
    const inputs = detect ? await audio.detectInputs().catch(e => { micError(e); return []; }) : await audio.listInputs();
    const cur = prefs.get('inputDevice', '');
    const named = inputs.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const devSel = dd(named.some(d => d.deviceId === cur) ? cur : '', [{ value: '', label: 'Системный по умолчанию' }, ...named.map(d => ({ value: d.deviceId, label: d.label || 'Микрофон (нажмите «Определить»)' }))], v => {
      prefs.set('inputDevice', v);
      if (audio.inputOpen()) { audio.closeInput(); audio.openInput().catch(micError); }
    }, { width: '100%' });
    const noLabels = named.length && named.every(d => !d.label);
    fill(micBox,
      h('div.row', { style: { width: '100%' } }, devSel,
        h('button.ui-btn.secondary.slim', { 'data-tip': 'Найти микрофоны (спросит разрешение у Windows)', onclick: () => renderMic(true).then(() => renderOut()) }, icon('refresh'), 'Определить')),
      h('div.row', { style: { width: '100%' } },
        h('button.ui-btn.secondary.slim', { onclick: async () => { if (audio.inputOpen()) audio.closeInput(); else await audio.openInput().catch(micError); renderMic(); } }, icon('mic'), audio.inputOpen() ? 'Остановить проверку' : 'Проверить'),
        micMeter,
        h(`button.ui-btn.secondary.slim${prefs.get('monitor', false) ? '.on' : ''}`, {
          'data-tip': 'Слышать себя в наушниках — включайте только в наушниках, иначе будет свист',
          onclick: async () => { const on = !prefs.get('monitor', false); audio.setMonitor(on); if (on && !audio.inputOpen()) await audio.openInput().catch(micError); renderMic(); },
        }, icon('headphones'), prefs.get('monitor', false) ? 'Слышу себя' : 'Слышать себя')),
      !inputs.length ? h('span', { style: { color: 'var(--p-red-8)', fontSize: '12px' } }, 'Микрофоны не найдены — подключите микрофон и нажмите «Определить»')
        : noLabels ? h('span.dim', { style: { fontSize: '12px' } }, 'Названия микрофонов появятся после «Определить» (Windows спросит разрешение)')
        : h('span.dim', { style: { fontSize: '12px' } }, `Найдено микрофонов: ${named.length}. Скажите что-нибудь при включённой проверке — полоска должна двигаться.`));
  };
  await renderMic();
  const outBox = h('div.col', { style: { gap: '6px', width: '100%' } });
  const renderOut = async () => {
    const outs = (await audio.listOutputs()).filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const cur = prefs.get('outputDevice', '');
    const sel = dd(outs.some(d => d.deviceId === cur) ? cur : '', [{ value: '', label: 'Системный по умолчанию' }, ...outs.map(d => ({ value: d.deviceId, label: d.label || 'Устройство вывода (нажмите «Определить» у микрофона)' }))], v => audio.setOutputDevice(v), { width: '100%' });
    if (!audio.outputSupported()) sel.disabled = true;
    fill(outBox,
      h('div.row', { style: { width: '100%' } }, sel,
        h('button.ui-btn.secondary.slim', { 'data-tip': 'Короткий тестовый сигнал в выбранное устройство', onclick: () => audio.testTone() }, icon('play'), 'Тест')),
      !audio.outputSupported() ? h('span.dim', { style: { fontSize: '12px' } }, 'Выбор вывода недоступен в этой версии WebView — звук идёт в системное устройство') : null);
  };
  await renderOut();
  const num = (key, def, { min, max, step, suffix }) => {
    const i = h('input', { type: 'number', value: prefs.get(key, def), min, max, step, style: { width: '90px' } });
    i.addEventListener('change', () => prefs.set(key, clamp(+i.value || 0, min, max)));
    return h('div.row', {}, i, h('span.dim', {}, suffix));
  };
  const chk = (key, def, label, onChange) => {
    const c = h('input', { type: 'checkbox', checked: prefs.get(key, def) });
    c.addEventListener('change', () => { prefs.set(key, c.checked); onChange?.(c.checked); });
    return h('label.row', { style: { cursor: 'pointer' } }, c, label);
  };
  const nameIn = h('input', { type: 'text', value: session.user?.displayName || '', spellcheck: false });
  const avaBox = h('div.ava-edit');
  const renderAva = () => {
    const u = session.user;
    const drop = h('div.ava-drop', { 'data-tip': 'Нажмите или перетащите картинку', onclick: pickAvatar }, avatar(u, 64));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) uploadAvatar(f).then(renderAva); });
    fill(avaBox, drop, h('div.acts', {},
      h('button.ui-btn.secondary.slim', { onclick: pickAvatar }, icon('upload'), u?.avatar ? 'Сменить…' : 'Загрузить…'),
      u?.avatar ? h('button.ui-btn.secondary.slim', { onclick: async () => { await removeAvatar(); renderAva(); } }, icon('delete'), 'Убрать') : null,
      h('span.dim', { style: { fontSize: '11px' } }, 'PNG, JPG, WebP — обрежется до квадрата; GIF и анимированный WebP (до 10 МБ) будут двигаться')));
  };
  const pickAvatar = () => {
    const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    inp.onchange = () => inp.files[0] && uploadAvatar(inp.files[0]).then(renderAva);
    inp.click();
  };
  renderAva();
  audio.audioCtx(); // чтобы показать реальную выходную задержку
  const lat = audio.outLatency();
  modal({
    title: 'Настройки', width: 620,
    body: h('div.col', {},
      h('div.t-def-sb', {}, 'Профиль'),
      h('div.f', {}, h('label', {}, 'Имя'), nameIn),
      h('div.f', {}, h('label', {}, 'Аватарка'), avaBox),
      h('div.t-def-sb', { style: { marginTop: '10px' } }, 'Запись'),
      h('div.f.top', {}, h('label', {}, 'Микрофон'), micBox),
      h('div.f.top', {}, h('label', {}, 'Вывод звука'), outBox),
      h('div.f', {}, h('label', {}, 'Задержка входа'), num('inputLatencyMs', 20, { min: -500, max: 1000, step: 1, suffix: `мс + выход ${(lat * 1000).toFixed(0)} мс (авто)` })),
      h('div.hint', {}, 'Если голос в дублях опаздывает относительно видео — увеличьте, если спешит — уменьшите.'),
      h('div.f', {}, h('label', {}, 'Преролл реплики'), num('preroll', 2, { min: 0, max: 10, step: 0.5, suffix: 'с до начала реплики (обратный отсчёт)' })),
      h('div.f', {}, h('label', {}, 'Хвост реплики'), num('tail', 0.6, { min: 0, max: 5, step: 0.1, suffix: 'с после конца — автостоп' })),
      h('div.f', {}, h('label', {}, 'Преролл свободной записи'), num('freePreroll', 0, { min: 0, max: 10, step: 0.5, suffix: 'с (клавиша R)' })),
      h('div.f', {}, h('label', {}, ''), chk('muteOriginalOnRec', false, 'Глушить оригинал во время записи (если пишете без наушников)')),
      h('div.f', {}, h('label', {}, ''), chk('autoReview', false, 'Сразу прослушать дубль после записи')),
      h('div.t-def-sb', { style: { marginTop: '10px' } }, 'Оригинал под озвучкой'),
      h('div.f', {}, h('label', {}, 'Режим'), dd(audio.duckMode(), Object.entries(audio.DUCK_MODES).map(([value, label]) => ({ value, label })), v => audio.setDuckMode(v), { width: '100%' })),
      h('div.f', {}, h('label', {}, 'Приглушение (закадр)'), num('duckDb', -14, { min: -40, max: 0, step: 1, suffix: 'дБ' })),
      h('div.hint', {}, 'Закадр — оригинал тише, пока звучит голос дабера. Дубляж — из оригинала вырезается центр стерео (обычно там голоса), музыка и шумы остаются. Переключение — клавиша D.'),
      h('div.t-def-sb', { style: { marginTop: '10px' } }, 'Интерфейс'),
      h('div.f', {}, h('label', {}, ''), chk('returnOnStop', false, 'После стопа возвращать плейхед к месту старта (кнопка ↶ в транспорте)', () => updateHeader())),
      h('div.f', {}, h('label', {}, ''), chk('scrubAudio', true, 'Звук под курсором при перетаскивании (скраб)')),
      h('div.f', {}, h('label', {}, ''), chk('showSubs', true, 'Показывать текст реплики поверх видео', () => refreshTimeline())),
      h('div.f', {}, h('label', {}, 'Скорость ленты ритмо'), num('rythmoSpeed', 160, { min: 40, max: 600, step: 10, suffix: 'пикс/с' }))),
    onClose: () => offMeter(),
    buttons: [{ label: 'Готово', primary: true, onClick: async close => {
      close();
      const displayName = nameIn.value.trim();
      if (session.user && displayName && displayName !== session.user.displayName) {
        try {
          const { user } = await api('/api/me', { method: 'PATCH', body: { displayName } });
          applyProfile(user);
        } catch (e) { toast(e.message, 'err'); }
      }
    } }],
  });
}

function showHotkeys() {
  const rows = [
    ['Пробел', 'Играть / стоп (во время записи — стоп)'], ['Shift+Пробел', 'Стоп с возвратом к месту старта'], ['R', 'Запись на свою дорожку с плейхеда'], ['Shift+R', 'Записать выбранную реплику (преролл, автостоп)'],
    ['↑ / ↓', 'Предыдущая / следующая реплика'], ['← / →', 'Плейхед ±1 с (Shift — ±5 с)'], ['Home / End', 'В начало / в конец'],
    ['Enter', 'Прослушать выбранную реплику'], ['P', 'Прослушать последний / выбранный дубль'], ['D', 'Оригинал под озвучкой: закадр / дубляж / как есть'], ['L', 'Повтор выбранного'], ['S', 'Разрезать клип по плейхеду'], ['M', 'Маркер'],
    ['Ctrl+C / Ctrl+X / Ctrl+V', 'Копировать / вырезать / вставить у плейхеда'], ['Ctrl+D', 'Дублировать сразу после выделенного'],
    ['Ctrl+A', 'Выделить все клипы и реплики'], ['Alt+перетаскивание', 'Копия клипа или реплики'], ['Alt+← / →', 'Сдвиг выделенного на кадр (Shift — на 10)'],
    ['Z', 'Показать выделенное целиком'], ['Delete', 'Удалить выбранное'], ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить свои действия'], ['Ctrl+колесо, + / −', 'Масштаб таймлайна'],
    ['Shift+протяжка по линейке', 'Диапазон повтора'], ['Ctrl+E', 'Экспорт'], ['Ctrl+,', 'Настройки'],
  ];
  modal({ title: 'Горячие клавиши', width: 520, body: h('div.kbd-list', {}, rows.flatMap(([k, d]) => [h('kbd', {}, k), h('span', {}, d)])), buttons: [{ label: 'OK', primary: true }] });
}

// ---------- клавиатура ----------
// клик по кнопке/ползунку не должен забирать фокус у горячих клавиш
addEventListener('pointerup', e => {
  const t = e.target.closest?.('button, input[type=range], input[type=checkbox], .ui-dd');
  if (t && !t.closest('.jd-modal')) setTimeout(() => { if (document.activeElement === t) t.blur(); }, 0);
}, true);

addEventListener('keydown', e => {
  if (e.key === ',' && e.ctrlKey) { e.preventDefault(); openSettings(); return; }
  if (screen !== 'studio') return;
  if (document.querySelector('.jd-modal-back')) return;
  const t = e.target;
  const textual = t.closest?.('textarea, select, [contenteditable]') ||
    (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color', 'file'].includes(t.type));
  if (textual) return;
  // стрелки у ползунка оставляем ему; пробел/Enter у кнопки не должен «нажимать» её повторно
  if (t.type === 'range' && e.code.startsWith('Arrow')) return;
  if (t.tagName === 'BUTTON' || t.tagName === 'INPUT') t.blur?.();
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (k === 'z' || k === 'я') && !e.shiftKey) { e.preventDefault(); sync.undo(); return; }
  if (ctrl && ((k === 'z' || k === 'я') && e.shiftKey || k === 'y' || k === 'н' || k === 'Z')) { e.preventDefault(); sync.redo(); return; }
  if (ctrl && (k === 'e' || k === 'у')) { e.preventDefault(); openExport(); return; }
  // правка — по физическим клавишам (работает и в русской раскладке)
  if (ctrl && !e.shiftKey) {
    const act = { KeyC: copySelection, KeyX: cutSelection, KeyV: pasteClipboard, KeyD: duplicateSelection, KeyA: selectAll }[e.code];
    if (act) { e.preventDefault(); act(); return; }
  }
  if (ctrl) return;
  // Alt+←/→ — сдвинуть выделенное на кадр (Shift — на 10 кадров)
  if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
    e.preventDefault();
    nudgeSelection(e.code === 'ArrowLeft' ? -1 : 1, e.shiftKey);
    return;
  }
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (audio.recording()) audio.stopRecording();
      else if (e.shiftKey && audio.isPlaying()) audio.stop({ returnToStart: true }); // Shift+Пробел — стоп с возвратом
      else audio.toggle();
      break;
    case 'KeyR': e.preventDefault(); e.shiftKey ? recordCue() : toggleRecord(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); break;
    case 'KeyS': e.preventDefault(); splitAtPlayhead(); break;
    case 'KeyM': e.preventDefault(); if (canEdit()) addMarker(audio.position()); break;
    case 'KeyL': e.preventDefault(); toggleLoop(); break;
    case 'KeyP': e.preventDefault(); reviewLast(); break;
    case 'KeyZ': e.preventDefault(); zoomToSelection(); break;
    case 'KeyD': e.preventDefault(); cycleDuck(); break;
    case 'Home': e.preventDefault(); audio.seek(0); scrollToTime(0); break;
    case 'End': e.preventDefault(); { const t = audio.projectEnd(); audio.seek(t); scrollToTime(t); } break;
    case 'ArrowLeft': e.preventDefault(); audio.seek(audio.position() - (e.shiftKey ? 5 : 1)); break;
    case 'ArrowRight': e.preventDefault(); audio.seek(audio.position() + (e.shiftKey ? 5 : 1)); break;
    case 'ArrowUp': e.preventDefault(); jumpCue(-1); break;
    case 'ArrowDown': e.preventDefault(); jumpCue(1); break;
    case 'Enter': {
      const q = [...ui.sel].map(id => doc.items.get(id)).find(i => i?.kind === 'cue');
      if (q) { e.preventDefault(); audio.play(Math.max(0, q.start - 0.5)); }
      break;
    }
    case 'Equal': case 'NumpadAdd': e.preventDefault(); setPps(Number(prefs.get('pps', 60)) * 1.4); break;
    case 'Minus': case 'NumpadSubtract': e.preventDefault(); setPps(Number(prefs.get('pps', 60)) / 1.4); break;
    case 'Escape': select([]); audio.setLoop(null); break;
    case 'F1': e.preventDefault(); showHotkeys(); break;
  }
});
window.addEventListener('jitdub:recordCue', e => recordCue(e.detail));

// ---------- сплиттеры ----------
function applySplits() {
  const s = document.documentElement.style;
  s.setProperty('--left-w', prefs.get('split.left', 320) + 'px');
  s.setProperty('--right-w', prefs.get('split.right', 300) + 'px');
  s.setProperty('--tl-h', prefs.get('split.timeline', 360) + 'px');
}

function initSplitters() {
  for (const sp of document.querySelectorAll('.splitter')) {
    sp.addEventListener('pointerdown', e => {
      e.preventDefault();
      const kind = sp.dataset.split;
      const start = { x: e.clientX, y: e.clientY, v: prefs.get('split.' + kind, { left: 320, right: 300, timeline: 360 }[kind]) };
      sp.classList.add('drag');
      const move = ev => {
        let v = start.v;
        if (kind === 'left') v = clamp(start.v + (ev.clientX - start.x), 220, 600);
        if (kind === 'right') v = clamp(start.v - (ev.clientX - start.x), 240, 560);
        if (kind === 'timeline') v = clamp(start.v - (ev.clientY - start.y), 160, innerHeight - 330);
        prefs.set('split.' + kind, v);
        applySplits();
      };
      const up = () => { sp.classList.remove('drag'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  }
}

// ---------- строка состояния ----------
function renderStatus() {
  const bar = $('statusbar');
  const L = $('st-left'), R = $('st-right');
  if (screen !== 'studio') {
    bar.className = '';
    fill(L);
    fill(R, h('span', {}, `JitDub ${version}`));
    return;
  }
  bar.className = doc.status === 'online' ? '' : 'off';
  const pend = sync.pendingCount();
  fill(L,
    h('span', {}, { online: '● в сети', connecting: '◌ подключение…', offline: '○ нет соединения' }[doc.status]),
    h('span', {}, `${new Set([...doc.online.values()].map(o => o.userId)).size} онлайн`),
    pend ? h('span', {}, `отправка: ${pend}`) : null,
    audio.recording() ? h('span', {}, '● идёт запись') : null);
  const armed = tracks().find(t => t.id === ui.armed);
  fill(R,
    armed ? h('span', {}, `запись → ${armed.name}`) : null,
    ui.sel.size ? h('span', {}, `выбрано: ${ui.sel.size}`) : null,
    h('span', {}, `ред. ${doc.rev}`),
    h('span', {}, `${(audio.outLatency() * 1000).toFixed(0)} мс`));
}

// ---------- события документа ----------
docEvents.on('state', () => {
  if (firstState) {
    firstState = false;
    audio.preloadAll();
    // новый проект без реплик — подогнать масштаб под видео, когда оно откроется
  }
  renderHeader();
  renderStatus();
});
docEvents.on('change', () => { updateHeader(); renderStatus(); });
docEvents.on('history', updateHeader);
docEvents.on('status', () => { updateHeader(); renderStatus(); });
docEvents.on('online', () => { renderOnline(); renderStatus(); });
docEvents.on('presence', (o, changed) => { if (changed?.has('recording')) renderOnline(); }); // кружок «пишет» на аватарке
docEvents.on('members', renderOnline);
docEvents.on('error', m => toast(m, 'err'));
docEvents.on('fatal', reason => { toast(reason, 'err', 6000); goLobby(); });
docEvents.on('videoLoaded', () => { if (!byKind('clip').length && !cues().length) setPps((document.querySelector('.tl-lanes')?.clientWidth - 60) / Math.max(30, doc.project?.video?.duration || 60), 0); });
uiEvents.on('select', renderStatus);
uiEvents.on('arm', renderStatus);
audio.events.on('record', renderStatus);

// версия приложения — в строке состояния; проверка обновлений в фоне
let version = '';
appVersion().then(v => { version = v; renderStatus(); });
window.addEventListener('jitdub:update', () => renderHeader());
startUpdateChecks();

boot();
