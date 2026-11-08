// Мультитрековый таймлайн (как в Audition): линейка, дорожка реплик, дорожки актёров с клипами и волнами,
// плейхеды всех участников, перетаскивание/подрезка клипов и реплик с привязкой, выделение рамкой.
import { h, fill, clamp, fmtTime, uid, charColor, avatar, gainToDb, throttle } from './util.js';
import { icon } from './icons.js';
import { doc, events as docEvents, tracks, cues, byKind, member, canEdit, update, batch, add, presence } from './sync.js';
import * as audio from './audio.js';
import { ui, uiEvents, select, arm, ensureArmed, setSnap, setFollow, pruneSelection } from './ui.js';
import { menu, prompt, toast } from './kit.js';
import { prefs } from './api.js';

const CUE_H = 38;
const TRACK_H = 68;
const HEAD_W = 220;
const TRACK_COLORS = ['#3574F0', '#5FAD65', '#E08855', '#955AE0', '#24A394', '#DB5C5C', '#F2C55C', '#E06AA8', '#4FB3D9', '#A3C44E'];

let el = {};
let pps = prefs.get('pps', 60); // пикселей на секунду
const clipEls = new Map();
const cueEls = new Map();
const remoteEls = new Map(); // sid → { line, flag }
let rows = [];               // [{ kind: 'cues'|'track', id, y, h }]
let renderQueued = false;
let drag = null;
let followPaused = false;   // пользователь сам прокрутил таймлайн во время воспроизведения
let autoScrollX = -1;        // последняя прокрутка, сделанная следованием (её не считаем ручной)

export function mountTimeline(root) {
  const zoom = h('input.zoom', { type: 'range', min: 0, max: 100, step: 1, value: ppsToSlider(pps), oninput: e => setPps(sliderToPps(+e.target.value)) });
  el.zoom = zoom;
  el.snapBtn = h('button.ui-ib', { 'data-tip': 'Привязка к краям реплик, клипов и плейхеду', onclick: () => setSnap(!ui.snap) }, icon('magnet'));
  el.followBtn = h('button.ui-ib', { 'data-tip': 'Следовать за плейхедом', onclick: () => setFollow(!ui.follow) }, icon('fwd'));
  el.info = h('span.dim', { style: { fontSize: '11px', marginLeft: '6px' } });
  const bar = h('div.tl-bar', {},
    h('button.ui-btn.secondary.slim', { onclick: addTrack, 'data-tip': 'Добавить дорожку (актёра)' }, icon('add'), 'Дорожка'),
    h('span', { style: { width: '6px' } }),
    el.snapBtn, el.followBtn,
    el.info,
    h('span.grow'),
    h('button.ui-ib', { 'data-tip': 'Отдалить (−)', onclick: () => setPps(pps / 1.4) }, icon('zoomOut')),
    zoom,
    h('button.ui-ib', { 'data-tip': 'Приблизить (+)', onclick: () => setPps(pps * 1.4) }, icon('zoomIn')),
    h('button.ui-ib', { 'data-tip': 'Весь проект', onclick: fitAll }, icon('fit')));

  el.rulerCanvas = h('canvas');
  el.ruler = h('div.tl-ruler', {}, el.rulerCanvas);
  el.headsInner = h('div.inner');
  el.heads = h('div.tl-heads', {}, el.headsInner);
  el.lanesInner = h('div.inner');
  el.lanes = h('div.tl-lanes', {}, el.lanesInner);
  el.playhead = h('div.playhead');
  el.snapline = h('div.snapline');
  el.loop = h('div.loopr', { style: { display: 'none' } });
  el.corner = h('div.tl-corner', {}, icon('users', { size: 14 }), h('span', {}, 'Дорожки'));
  const grid = h('div.tl', { style: { '--th-w': HEAD_W + 'px' } }, el.corner, el.ruler, el.heads, el.lanes);
  fill(root, bar, grid);

  el.lanes.addEventListener('scroll', () => {
    el.heads.scrollTop = el.lanes.scrollTop;
    if (el.lanes.scrollLeft !== autoScrollX && audio.isPlaying()) followPaused = true;
    drawRuler();
  });
  // колесо/полоса прокрутки во время воспроизведения — пользователь смотрит в другое место, не дёргаем вид
  el.lanes.addEventListener('wheel', () => { if (audio.isPlaying()) followPaused = true; }, { passive: true });
  el.lanes.addEventListener('wheel', onWheel, { passive: false });
  el.ruler.addEventListener('wheel', onWheel, { passive: false });
  el.heads.addEventListener('wheel', e => { el.lanes.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
  el.ruler.addEventListener('pointerdown', onRulerDown);
  el.lanes.addEventListener('pointerdown', onLanesDown);
  el.lanes.addEventListener('dblclick', onLanesDbl);
  el.lanes.addEventListener('contextmenu', onLanesMenu);
  el.lanes.addEventListener('dragover', onDragOver);
  el.lanes.addEventListener('drop', onDrop);
  new ResizeObserver(() => { drawRuler(); }).observe(el.ruler);

  docEvents.on('state', () => { clipEls.clear(); cueEls.clear(); fill(el.lanesInner); queue(); });
  docEvents.on('change', () => { pruneSelection(); queue(); });
  docEvents.on('presence', o => { renderRemote(); if ('recording' in o.presence || 'selection' in o.presence) queue(); });
  docEvents.on('online', () => { renderRemote(); queue(); });
  docEvents.on('members', queue);
  uiEvents.on('select', queue);
  uiEvents.on('arm', queue);
  uiEvents.on('view', () => { syncButtons(); queue(); });
  audio.events.on('take', queue);
  audio.events.on('tick', onTick);
  audio.events.on('seek', onTick);
  audio.events.on('transport', () => { followPaused = false; onTick(audio.position()); renderLoop(); });
  audio.events.on('record', queue);
  syncButtons();
}

function syncButtons() {
  el.snapBtn.classList.toggle('on', ui.snap);
  el.followBtn.classList.toggle('on', ui.follow);
}

const ppsToSlider = p => Math.round((Math.log(p / 4) / Math.log(400 / 4)) * 100);
const sliderToPps = s => 4 * (400 / 4) ** (s / 100);

export function setPps(p, anchorTime = null) {
  const old = pps;
  pps = clamp(p, 4, 400);
  prefs.set('pps', pps);
  el.zoom.value = ppsToSlider(pps);
  // якорь: время под курсором мыши (колесо), иначе плейхед, если он на экране, иначе центр экрана —
  // эта точка остаётся на месте. Ширину и прокрутку меняем сразу (синхронно), а не после отрисовки:
  // иначе несколько шагов ползунка подряд считались от устаревшей прокрутки и вид «уезжал».
  const L = el.lanes.scrollLeft, W = el.lanes.clientWidth;
  let t = anchorTime;
  if (t == null) {
    const ph = audio.position();
    t = ph * old >= L && ph * old <= L + W ? ph : (L + W / 2) / old;
  }
  const vx = t * old - L;
  el.lanesInner.style.width = Math.max(W, audio.projectEnd() * pps + 600) + 'px';
  el.lanes.scrollLeft = Math.max(0, t * pps - vx);
  el.snapline.style.display = 'none';
  queue();
}

function fitAll() {
  const w = el.lanes.clientWidth - 40;
  setPps(w / audio.projectEnd(), 0);
  queue(() => { el.lanes.scrollLeft = 0; });
}

function onWheel(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const r = el.lanes.getBoundingClientRect();
    const t = (e.clientX - r.left + el.lanes.scrollLeft) / pps;
    setPps(pps * (e.deltaY < 0 ? 1.18 : 1 / 1.18), t);
  } else if (e.shiftKey || e.currentTarget === el.ruler) {
    e.preventDefault();
    el.lanes.scrollLeft += e.deltaY || e.deltaX;
  }
}

// ---------- раскладка и отрисовка ----------
function layout() {
  rows = [{ kind: 'cues', id: '__cues', y: 0, h: CUE_H }];
  let y = CUE_H;
  for (const t of tracks()) { rows.push({ kind: 'track', id: t.id, y, h: TRACK_H }); y += TRACK_H; }
  return y;
}

const rowOf = id => rows.find(r => r.id === id);
const rowAt = y => rows.find(r => y >= r.y && y < r.y + r.h) || null;

let afterRender = [];
function queue(fn) {
  if (typeof fn === 'function') afterRender.push(fn); // обработчики событий передают сюда свои аргументы — их игнорируем
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
    const fns = afterRender; afterRender = [];
    for (const f of fns) f();
  });
}
export const refresh = () => queue();

function render() {
  if (!doc.project) return;
  ensureArmed();
  if (!drag) el.snapline.style.display = 'none'; // линия привязки живёт только во время перетаскивания
  const totalH = layout();
  const width = Math.max(el.lanes.clientWidth, audio.projectEnd() * pps + 600);
  el.lanesInner.style.width = width + 'px';
  el.lanesInner.style.height = Math.max(totalH + 40, el.lanes.clientHeight - 1) + 'px';
  el.headsInner.style.height = totalH + 60 + 'px';
  const recBy = remoteRecording();
  renderHeads(recBy);
  renderLanes(recBy);
  renderClips();
  renderCues();
  renderMarkers();
  renderRemote();
  renderLoop();
  onTick(audio.position());
  drawRuler();
  const nC = byKind('clip').length, nQ = byKind('cue').length;
  el.info.textContent = `${tracks().length} дор. · ${nC} клип. · ${nQ} репл.`;
}

// кто сейчас пишет на какую дорожку (другие участники)
function remoteRecording() {
  const m = new Map();
  for (const o of doc.online.values()) if (o.sid !== doc.you?.sid && o.presence?.recording) m.set(o.presence.recording, o.userId);
  const mine = audio.recording();
  if (mine) m.set(mine.trackId, doc.you?.id);
  return m;
}

function renderHeads(recBy) {
  const kids = [];
  kids.push(h('div.thead.cueh', { style: { top: 0, height: CUE_H + 'px', '--tc': '#6F737A' } },
    h('div.cbar'),
    h('div.in', {}, h('div.r1', {}, icon('script'), h('span.nm', {}, 'Реплики'), h('span.dim', { style: { fontSize: '11px' } }, String(byKind('cue').length))))));
  for (const t of tracks()) {
    const r = rowOf(t.id);
    const owner = member(t.ownerId);
    const isSel = ui.sel.has(t.id);
    const g = t.gain ?? 1;
    const vol = h('input', { type: 'range', min: 0, max: 2, step: 0.01, value: g, 'data-tip': 'Громкость дорожки' });
    const db = h('span.db', {}, gainToDb(g).toFixed(1));
    vol.addEventListener('input', () => { db.textContent = gainToDb(+vol.value).toFixed(1); });
    vol.addEventListener('change', () => update(t.id, { gain: +vol.value }, { label: 'громкость' }));
    vol.addEventListener('dblclick', () => update(t.id, { gain: 1 }));
    const recording = recBy.get(t.id);
    kids.push(h(`div.thead${isSel ? '.sel' : ''}${recording ? '.recording' : ''}`, {
      style: { top: r.y + 'px', height: r.h + 'px', '--tc': t.color || '#3574F0' },
      onpointerdown: e => { if (e.target.closest('button,input')) return; select(t.id, { toggle: e.ctrlKey || e.shiftKey }); },
      oncontextmenu: e => { e.preventDefault(); trackMenu(t, e.clientX, e.clientY); },
      ondblclick: e => { if (!e.target.closest('button,input')) renameTrack(t); },
    },
      h('div.cbar'),
      h('div.in', {},
        h('div.r1', {},
          owner ? avatar(owner, 18) : h('span.avatar', { style: { '--c': '#43454A', width: '18px', height: '18px', fontSize: '9px' } }, '?'),
          h('span.nm', { title: t.character ? `${t.name} — ${t.character}` : t.name }, t.name || 'Дорожка', t.character ? h('span.dim', { style: { fontWeight: 400 } }, ' · ' + t.character) : null),
          h('span.rec-ind', { title: recording ? `пишет: ${member(recording)?.displayName || ''}` : '' }),
          t.locked ? icon('lock', { size: 14 }) : null),
        h('div.r2', {},
          h(`button.tbtn-s.m${t.mute ? '.on' : ''}`, { 'data-tip': 'Заглушить', onclick: () => update(t.id, { mute: !t.mute }) }, 'M'),
          h(`button.tbtn-s.s${t.solo ? '.on' : ''}`, { 'data-tip': 'Соло', onclick: () => update(t.id, { solo: !t.solo }) }, 'S'),
          h(`button.tbtn-s.r${ui.armed === t.id ? '.on' : ''}`, { 'data-tip': 'Писать на эту дорожку', onclick: () => arm(t.id) }, 'R'),
          vol, db))));
  }
  fill(el.headsInner, kids);
}

function renderLanes(recBy) {
  // фоны строк держим первыми детьми, клипы/реплики — поверх (по ключам)
  let bg = el.lanesInner.querySelector(':scope > .lanes-bg');
  if (!bg) { bg = h('div.lanes-bg'); el.lanesInner.prepend(bg); }
  fill(bg, rows.map(r => h(`div.lane${r.kind === 'cues' ? '.cue-lane' : ''}${r.id === ui.armed ? '.armed' : ''}`, {
    style: { top: r.y + 'px', height: r.h + 'px' }, dataset: { row: r.id },
  })));
  if (!el.playhead.isConnected) el.lanesInner.append(el.playhead, el.snapline, el.loop);
}

function selColorFor(id) {
  for (const o of doc.online.values()) {
    if (o.sid === doc.you?.sid) continue;
    if (o.presence?.selection?.includes(id)) return member(o.userId)?.color || '#fff';
  }
  return null;
}

function renderClips() {
  const seen = new Set();
  const tmap = new Map(tracks().map(t => [t.id, t]));
  for (const c of byKind('clip')) {
    const t = tmap.get(c.trackId);
    const r = t && rowOf(t.id);
    if (!r) continue;
    seen.add(c.id);
    let e = clipEls.get(c.id);
    if (!e) {
      e = h('div.clip', { dataset: { id: c.id, type: 'clip' } }, h('canvas'), h('div.cn'), h('div.eh.l', { dataset: { edge: 'l' } }), h('div.eh.r', { dataset: { edge: 'r' } }));
      clipEls.set(c.id, e);
      el.lanesInner.append(e);
    }
    if (drag?.ids?.has(c.id)) continue; // во время перетаскивания позицию задаёт drag
    placeClip(e, c, r.y, t);
  }
  for (const [id, e] of clipEls) if (!seen.has(id)) { e.remove(); clipEls.delete(id); }
}

function placeClip(e, c, y, t) {
  const w = Math.max(2, c.duration * pps);
  e.style.left = c.start * pps + 'px';
  e.style.width = w + 'px';
  e.style.top = y + 3 + 'px';
  e.style.height = TRACK_H - 6 + 'px';
  e.style.setProperty('--tc', t?.color || '#3574F0');
  e.classList.toggle('sel', ui.sel.has(c.id));
  e.classList.toggle('muted', !!c.mute);
  const lc = selColorFor(c.id);
  e.classList.toggle('locked-by', !!lc);
  if (lc) e.style.setProperty('--lc', lc);
  const take = doc.takes.get(c.takeId);
  const author = member(take?.userId);
  e.querySelector('.cn').textContent = c.name || take?.name || (author ? `дубль ${author.displayName}` : 'дубль');
  e.title = `${fmtTime(c.start)} – ${fmtTime(c.start + c.duration)}${author ? ' · ' + author.displayName : ''}`;
  const data = audio.takeData(c.takeId);
  e.classList.toggle('loading', !data);
  if (!data) audio.loadTake(c.takeId).catch(() => {});
  drawWave(e, c, data, w, t?.color);
  drawFades(e, c, w);
}

function drawWave(e, c, data, w, color) {
  const cv = e.querySelector('canvas');
  const H = TRACK_H - 6 - 16;
  const cw = Math.min(Math.ceil(w), 8192);
  const key = `${c.takeId}|${c.offset}|${c.duration}|${cw}|${c.gain}|${!!data}|${color}`;
  if (cv.dataset.key === key) return;
  cv.dataset.key = key;
  cv.width = cw; cv.height = H;
  cv.style.width = w + 'px'; cv.style.height = H + 'px';
  if (!data) return;
  const g = cv.getContext('2d');
  const { min, max, rate } = data.peaks;
  g.fillStyle = color ? mix(color, '#ffffff', 0.45) : '#9DB8F7';
  const mid = H / 2, amp = (H / 2) * Math.min(2, c.gain ?? 1);
  for (let x = 0; x < cw; x++) {
    const t0 = (c.offset || 0) + (x / cw) * c.duration, t1 = (c.offset || 0) + ((x + 1) / cw) * c.duration;
    let i0 = Math.floor(t0 * rate), i1 = Math.max(i0 + 1, Math.floor(t1 * rate));
    let lo = 0, hi = 0;
    for (let i = i0; i < i1 && i < min.length; i++) { if (min[i] < lo) lo = min[i]; if (max[i] > hi) hi = max[i]; }
    const y0 = mid - hi * amp, y1 = mid - lo * amp;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function drawFades(e, c, w) {
  e.querySelectorAll('.fade').forEach(f => f.remove());
  const mk = (left, width, dir) => h('div.fade', {
    style: { left: left + 'px', width: width + 'px' },
    html: `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${dir ? 'M0,100 L100,0 L0,0 Z' : 'M0,0 L100,100 L100,0 Z'}" fill="#0008"/><path d="${dir ? 'M0,100 L100,0' : 'M0,0 L100,100'}" stroke="#fff8" stroke-width="1.5" vector-effect="non-scaling-stroke" fill="none"/></svg>`,
  });
  if (c.fadeIn > 0) e.append(mk(0, c.fadeIn * pps, true));
  if (c.fadeOut > 0) e.append(mk(w - c.fadeOut * pps, c.fadeOut * pps, false));
}

function mix(a, b, k) {
  const p = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('');
}

function renderCues() {
  const seen = new Set();
  for (const q of byKind('cue')) {
    seen.add(q.id);
    let e = cueEls.get(q.id);
    if (!e) {
      e = h('div.cueb', { dataset: { id: q.id, type: 'cue' } });
      cueEls.set(q.id, e);
      el.lanesInner.append(e);
    }
    if (drag?.ids?.has(q.id)) continue;
    placeCue(e, q);
  }
  for (const [id, e] of cueEls) if (!seen.has(id)) { e.remove(); cueEls.delete(id); }
}

function placeCue(e, q) {
  e.style.left = q.start * pps + 'px';
  e.style.width = Math.max(4, (q.end - q.start) * pps) + 'px';
  e.style.top = 4 + 'px';
  e.style.height = CUE_H - 8 + 'px';
  e.style.setProperty('--cc', charColor(q.character));
  e.className = `cueb st-${q.status || 'todo'}${ui.sel.has(q.id) ? ' sel' : ''}`;
  const lc = selColorFor(q.id);
  e.style.outline = lc ? `2px solid ${lc}` : '';
  const ass = member(q.assigneeId);
  e.title = `${q.character ? q.character + ': ' : ''}${q.text}\n${fmtTime(q.start)} – ${fmtTime(q.end)}${ass ? '\nозвучивает: ' + ass.displayName : ''}`;
  fill(e, q.character ? h('b', {}, q.character) : null, q.text, h('div.eh.l', { dataset: { edge: 'l' } }), h('div.eh.r', { dataset: { edge: 'r' } }));
}

function renderMarkers() {
  el.lanesInner.querySelectorAll(':scope > .marker').forEach(m => m.remove());
  for (const m of byKind('marker')) el.lanesInner.append(h('div.marker', { style: { left: m.time * pps + 'px', '--mc': m.color || '#F2C55C' }, title: m.label }));
}

function renderLoop() {
  const l = audio.loop();
  if (!el.loop) return;
  el.loop.style.display = l ? '' : 'none';
  if (l) { el.loop.style.left = l.a * pps + 'px'; el.loop.style.width = (l.b - l.a) * pps + 'px'; }
}

// плейхеды и флажки других участников
function renderRemote() {
  if (!el.lanesInner) return;
  const seen = new Set();
  for (const o of doc.online.values()) {
    if (o.sid === doc.you?.sid || o.presence?.playhead == null) continue;
    seen.add(o.sid);
    let r = remoteEls.get(o.sid);
    if (!r) {
      r = { line: h('div.rplay'), flag: h('div.rflag') };
      remoteEls.set(o.sid, r);
    }
    if (!r.line.isConnected) el.lanesInner.append(r.line);
    if (!r.flag.isConnected) el.ruler.append(r.flag);
    const u = member(o.userId);
    const x = o.presence.playhead * pps;
    r.line.style.left = x + 'px';
    r.line.style.setProperty('--pc', u?.color || '#fff');
    r.line.classList.toggle('rec', !!o.presence.recording);
    r.flag.style.setProperty('--pc', u?.color || '#fff');
    r.flag.style.left = x - el.lanes.scrollLeft + 'px';
    r.flag.textContent = (o.presence.recording ? '● ' : o.presence.playing ? '▶ ' : '') + (u?.displayName || '?');
  }
  for (const [sid, r] of remoteEls) if (!seen.has(sid)) { r.line.remove(); r.flag.remove(); remoteEls.delete(sid); }
}

function onTick(t) {
  if (!el.playhead) return;
  const x = t * pps;
  el.playhead.style.left = x + 'px';
  el.playhead.classList.toggle('rec', !!audio.recording());
  if (audio.isPlaying() && ui.follow && !drag && !followPaused) {
    const L = el.lanes.scrollLeft, W = el.lanes.clientWidth;
    if (x > L + W - 40 || x < L) { el.lanes.scrollLeft = x - 60; autoScrollX = el.lanes.scrollLeft; }
  }
  drawRulerHead(t);
  sendPos(t);
}
const sendPos = throttle(t => presence({ playhead: +t.toFixed(3), playing: audio.isPlaying(), recording: audio.recording()?.trackId || null }), 120);

// ---------- линейка ----------
function drawRuler() {
  const cv = el.rulerCanvas;
  if (!cv) return;
  const W = el.ruler.clientWidth, H = el.ruler.clientHeight;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const L = el.lanes.scrollLeft;
  // шаг делений: ~80 px между подписями
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find(s => s * pps >= 80) || 600;
  const minor = step / (step >= 60 ? 6 : step >= 1 ? 5 : 2.5 >= step ? 5 : 4);
  g.font = '10px "JetBrains Mono", Consolas, monospace';
  g.textBaseline = 'top';
  const t0 = Math.floor(L / pps / minor) * minor;
  for (let t = t0; t * pps - L < W; t += minor) {
    const x = Math.round(t * pps - L) + 0.5;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    g.strokeStyle = major ? '#6F737A' : '#43454A';
    g.beginPath(); g.moveTo(x, major ? H - 12 : H - 6); g.lineTo(x, H); g.stroke();
    if (major) { g.fillStyle = '#9DA0A8'; g.fillText(fmtTime(t, step < 1).replace(/^00:/, ''), x + 3, 4); }
  }
  // маркеры
  for (const m of byKind('marker')) {
    const x = m.time * pps - L;
    if (x < -10 || x > W + 10) continue;
    g.fillStyle = m.color || '#F2C55C';
    g.beginPath(); g.moveTo(x - 5, H - 9); g.lineTo(x + 5, H - 9); g.lineTo(x, H - 2); g.fill();
  }
  // флажки удалённых плейхедов — двигаем вместе со скроллом
  for (const [sid, r] of remoteEls) {
    const o = doc.online.get(sid);
    if (o) r.flag.style.left = o.presence.playhead * pps - L + 'px';
  }
  drawRulerHead(audio.position());
}

function drawRulerHead(t) {
  let mark = el.ruler.querySelector('.rhead');
  if (!mark) { mark = h('div.rhead', { style: { position: 'absolute', top: 0, bottom: 0, width: '1px', background: '#fff', pointerEvents: 'none' } }); el.ruler.append(mark); }
  mark.style.left = t * pps - el.lanes.scrollLeft + 'px';
  mark.style.background = audio.recording() ? 'var(--rec)' : '#fff';
}

function timeAtClient(x) {
  const r = el.lanes.getBoundingClientRect();
  return Math.max(0, (x - r.left + el.lanes.scrollLeft) / pps);
}

function onRulerDown(e) {
  if (e.button !== 0) return;
  const t0 = timeAtClient(e.clientX);
  if (e.shiftKey) {
    // Shift+протяжка по линейке — диапазон повтора
    const move = ev => { const t = timeAtClient(ev.clientX); audio.setLoop(Math.min(t0, t), Math.max(t0, t)); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    return;
  }
  audio.seek(snapTime(t0, null, true));
  const move = ev => { const t = timeAtClient(ev.clientX); audio.seek(t); audio.scrub(t); };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); el.snapline.style.display = 'none'; };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

// ---------- привязка ----------
function snapPoints(exclude) {
  const pts = [audio.position()];
  for (const it of doc.items.values()) {
    if (exclude?.has(it.id)) continue;
    if (it.kind === 'cue') pts.push(it.start, it.end);
    else if (it.kind === 'clip') pts.push(it.start, it.start + it.duration);
    else if (it.kind === 'marker') pts.push(it.time);
  }
  return pts;
}

function snapTime(t, exclude, force = false) {
  if (!ui.snap && !force) { el.snapline.style.display = 'none'; return t; }
  if (!ui.snap) return t;
  const th = 8 / pps;
  let best = null, bd = th;
  for (const p of snapPoints(exclude)) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
  if (best != null) { el.snapline.style.display = 'block'; el.snapline.style.left = best * pps + 'px'; return best; }
  el.snapline.style.display = 'none';
  return t;
}

// ---------- мышь на дорожках ----------
function onLanesDown(e) {
  if (e.button !== 0) return;
  const target = e.target.closest('[data-type]');
  const r = el.lanesInner.getBoundingClientRect();
  const y = e.clientY - r.top;
  const t = timeAtClient(e.clientX);
  if (!target) {
    // пустое место: клик — перемотка и сброс выделения, протяжка — выделение рамкой
    const row = rowAt(y);
    if (row?.kind === 'track' && !e.shiftKey) arm(row.id);
    marquee(e, t, y);
    return;
  }
  const id = target.dataset.id;
  const item = doc.items.get(id);
  if (!item) return;
  if (e.ctrlKey || e.shiftKey) select(id, { toggle: true });
  else if (!ui.sel.has(id)) select(id);
  if (!canEdit()) return;
  const edge = e.target.dataset.edge;
  if (edge) startTrim(e, item, edge);
  else startMove(e, t, y);
}

function marquee(e, t0, y0) {
  const box = h('div.marquee');
  let moved = false;
  const r = el.lanesInner.getBoundingClientRect();
  const move = ev => {
    const t1 = timeAtClient(ev.clientX), y1 = ev.clientY - r.top;
    if (!moved && Math.abs(t1 - t0) * pps < 4 && Math.abs(y1 - y0) < 4) return;
    if (!moved) { moved = true; el.lanesInner.append(box); }
    const x = Math.min(t0, t1) * pps, w = Math.abs(t1 - t0) * pps, y = Math.min(y0, y1), hh = Math.abs(y1 - y0);
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' });
    const a = Math.min(t0, t1), b = Math.max(t0, t1), ya = y, yb = y + hh;
    const ids = [];
    for (const c of byKind('clip')) { const rr = rowOf(c.trackId); if (rr && c.start < b && c.start + c.duration > a && rr.y < yb && rr.y + rr.h > ya) ids.push(c.id); }
    if (CUE_H > ya) for (const q of byKind('cue')) if (q.start < b && q.end > a) ids.push(q.id);
    select(ids, { add: ev.shiftKey });
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    box.remove();
    if (!moved) { if (!e.shiftKey) select([]); audio.seek(snapTime(t0, null)); el.snapline.style.display = 'none'; }
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

function startMove(e, t0, y0) {
  const items = [...ui.sel].map(id => doc.items.get(id)).filter(it => it && (it.kind === 'clip' || it.kind === 'cue'));
  if (!items.length) return;
  const ids = new Set(items.map(i => i.id));
  const orig = new Map(items.map(i => [i.id, { ...i }]));
  const trackList = tracks();
  const minStart = Math.min(...items.map(i => i.start));
  let dt = 0, dRow = 0, moved = false;
  const move = ev => {
    const t = timeAtClient(ev.clientX);
    const r = el.lanesInner.getBoundingClientRect();
    if (!moved && Math.abs(t - t0) * pps < 3 && Math.abs(ev.clientY - r.top - y0) < 3) return;
    if (!moved) { moved = true; drag = { ids }; }
    dt = Math.max(-minStart, t - t0);
    // привязка по ближайшему краю первого объекта
    const lead = items.find(i => i.start === minStart);
    const leadEnd = lead.kind === 'cue' ? lead.end - lead.start : lead.duration;
    const s = snapTime(lead.start + dt, ids);
    if (s !== lead.start + dt) dt = s - lead.start;
    else { const se = snapTime(lead.start + dt + leadEnd, ids); dt = se - leadEnd - lead.start; }
    dt = Math.max(-minStart, dt);
    follow(lead.start + dt, { exclude: ids });
    const row = rowAt(ev.clientY - r.top);
    const fromRow = rowAt(y0);
    if (row?.kind === 'track' && fromRow?.kind === 'track') dRow = trackList.findIndex(x => x.id === row.id) - trackList.findIndex(x => x.id === fromRow.id);
    for (const it of items) {
      const o = orig.get(it.id);
      if (it.kind === 'clip') {
        const ti = clamp(trackList.findIndex(x => x.id === o.trackId) + dRow, 0, trackList.length - 1);
        const tr = trackList[ti];
        placeClip(clipEls.get(it.id), { ...o, start: o.start + dt }, rowOf(tr.id).y, tr);
      } else {
        placeCue(cueEls.get(it.id), { ...o, start: o.start + dt, end: o.end + dt });
      }
    }
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    el.snapline.style.display = 'none';
    drag = null;
    if (!moved) return;
    const ops = [];
    for (const it of items) {
      const o = orig.get(it.id);
      if (it.kind === 'clip') {
        const ti = clamp(trackList.findIndex(x => x.id === o.trackId) + dRow, 0, trackList.length - 1);
        ops.push({ type: 'update', id: it.id, data: { start: round(o.start + dt), trackId: trackList[ti].id } });
      } else {
        ops.push({ type: 'update', id: it.id, data: { start: round(o.start + dt), end: round(o.end + dt) } });
      }
    }
    batch(ops, { label: 'перемещение' });
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

const round = v => Math.round(v * 1000) / 1000;

// при перетаскивании плейхед (а с ним кадр видео) встаёт туда, где край, и звучит кусочек под ним
function follow(t, opts) {
  if (audio.isPlaying()) return;
  audio.seek(t);
  audio.scrub(t, opts);
}

function startTrim(e, item, edge) {
  const o = { ...item };
  const ids = new Set([item.id]);
  drag = { ids };
  const maxLen = item.kind === 'clip' ? (audio.takeData(item.takeId)?.buffer.duration ?? (o.offset + o.duration)) : Infinity;
  let res = null;
  const move = ev => {
    const t = snapTime(timeAtClient(ev.clientX), ids);
    if (item.kind === 'clip') {
      if (edge === 'l') {
        const start = clamp(t, o.start - o.offset, o.start + o.duration - 0.02);
        const d = start - o.start;
        res = { start: round(start), offset: round(o.offset + d), duration: round(o.duration - d) };
      } else {
        const end = clamp(t, o.start + 0.02, o.start + maxLen - o.offset);
        res = { duration: round(end - o.start) };
      }
      const tr = tracks().find(x => x.id === o.trackId);
      placeClip(clipEls.get(item.id), { ...o, ...res }, rowOf(o.trackId).y, tr);
      const edgeT = edge === 'l' ? res.start : o.start + res.duration;
      follow(edgeT, { exclude: ids, extra: o });
    } else {
      res = edge === 'l' ? { start: round(Math.min(t, o.end - 0.05)) } : { end: round(Math.max(t, o.start + 0.05)) };
      placeCue(cueEls.get(item.id), { ...o, ...res });
      follow(res.start ?? res.end);
    }
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    el.snapline.style.display = 'none';
    drag = null;
    if (res) update(item.id, res, { label: 'подрезка' }); else queue();
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

function onLanesDbl(e) {
  const target = e.target.closest('[data-type]');
  if (target?.dataset.type === 'cue') { editCueText(doc.items.get(target.dataset.id)); return; }
  if (target) return;
  const r = el.lanesInner.getBoundingClientRect();
  const row = rowAt(e.clientY - r.top);
  if (row?.kind === 'cues' && canEdit()) addCueAt(timeAtClient(e.clientX));
}

export async function editCueText(q) {
  if (!q || !canEdit()) return;
  const text = await prompt('Текст реплики', { value: q.text, multiline: true, ok: 'Сохранить' });
  if (text != null && text !== q.text) update(q.id, { text });
}

export function addCueAt(t, len = 2) {
  const id = uid('q');
  add('cue', id, { start: round(t), end: round(t + len), text: '', character: '', status: 'todo' }, { label: 'реплика' });
  select(id);
  setTimeout(() => editCueText(doc.items.get(id)), 50);
}

function onLanesMenu(e) {
  e.preventDefault();
  const target = e.target.closest('[data-type]');
  const t = timeAtClient(e.clientX);
  if (target) {
    const id = target.dataset.id;
    if (!ui.sel.has(id)) select(id);
    const item = doc.items.get(id);
    if (item.kind === 'clip') clipMenu(item, e.clientX, e.clientY);
    else cueMenu(item, e.clientX, e.clientY);
    return;
  }
  const r = el.lanesInner.getBoundingClientRect();
  const row = rowAt(e.clientY - r.top);
  menu(e.clientX, e.clientY, [
    { label: 'Перейти сюда', icon: 'right', onClick: () => audio.seek(t) },
    { label: 'Добавить реплику здесь', icon: 'add', disabled: !canEdit(), onClick: () => addCueAt(t) },
    { label: 'Маркер здесь', icon: 'add', disabled: !canEdit(), sc: 'M', onClick: () => addMarker(t) },
    row?.kind === 'track' ? '-' : null,
    row?.kind === 'track' ? { label: 'Писать на эту дорожку', icon: 'mic', onClick: () => arm(row.id) } : null,
  ]);
}

export function addMarker(t) {
  add('marker', uid('m'), { time: round(t), label: '', color: '#F2C55C' }, { label: 'маркер' });
}

function clipMenu(c, x, y) {
  const n = ui.sel.size;
  menu(x, y, [
    { label: 'Разрезать по плейхеду', icon: 'split', sc: 'S', disabled: !canEdit(), onClick: () => splitAtPlayhead() },
    { label: c.mute ? 'Включить клип' : 'Заглушить клип', icon: c.mute ? 'show' : 'hide', disabled: !canEdit(), onClick: () => update(c.id, { mute: !c.mute }) },
    { label: 'Перейти к началу клипа', icon: 'left', onClick: () => audio.seek(c.start) },
    '-',
    { label: n > 1 ? `Удалить (${n})` : 'Удалить', icon: 'delete', sc: 'Del', danger: true, disabled: !canEdit(), onClick: deleteSelection },
  ]);
}

function cueMenu(q, x, y) {
  const st = s => ({ label: { todo: 'Не записана', recorded: 'Записана', approved: 'Принята', redo: 'Переписать' }[s], icon: q.status === s ? 'check' : null, disabled: !canEdit(), onClick: () => batch([...ui.sel].filter(id => doc.items.get(id)?.kind === 'cue').map(id => ({ type: 'update', id, data: { status: s } }))) });
  menu(x, y, [
    { label: 'Записать реплику', icon: 'mic', sc: 'Shift+R', onClick: () => window.dispatchEvent(new CustomEvent('jitdub:recordCue', { detail: q.id })) },
    { label: 'Прослушать', icon: 'play', onClick: () => { audio.setLoop(null); audio.seek(Math.max(0, q.start - 0.5)); audio.play(); } },
    { label: 'Изменить текст', icon: 'edit', disabled: !canEdit(), onClick: () => editCueText(q) },
    '-', st('todo'), st('recorded'), st('approved'), st('redo'), '-',
    { label: 'Удалить', icon: 'delete', sc: 'Del', danger: true, disabled: !canEdit(), onClick: deleteSelection },
  ]);
}

export function deleteSelection() {
  if (!canEdit()) return;
  const ops = [...ui.sel].map(id => doc.items.get(id)).filter(it => it && it.kind !== 'track').map(it => ({ type: 'remove', id: it.id }));
  if (!ops.length) return;
  batch(ops, { label: 'удаление' });
  select([]);
}

export function splitAtPlayhead() {
  if (!canEdit()) return;
  const t = audio.position();
  let targets = byKind('clip').filter(c => ui.sel.has(c.id) && c.start < t && c.start + c.duration > t);
  if (!targets.length) targets = byKind('clip').filter(c => c.trackId === ui.armed && c.start < t && c.start + c.duration > t);
  if (!targets.length) { toast('Под плейхедом нет клипа для разреза', 'warn'); return; }
  const ops = [];
  const newIds = [];
  for (const c of targets) {
    const left = round(t - c.start);
    const id = uid('k');
    newIds.push(id);
    const { id: _, kind, ...data } = c;
    ops.push({ type: 'update', id: c.id, data: { duration: left, fadeOut: 0 } });
    ops.push({ type: 'add', kind: 'clip', id, data: { ...data, start: round(t), offset: round((c.offset || 0) + left), duration: round(c.duration - left), fadeIn: 0 } });
  }
  batch(ops, { label: 'разрез' });
  select(newIds);
}

// ---------- дорожки ----------
export function addTrack() {
  if (!canEdit()) return;
  const all = tracks();
  const order = all.length ? Math.max(...all.map(t => t.order ?? 0)) + 1 : 0;
  const id = uid('t');
  const mine = !all.some(t => t.ownerId === doc.you.id);
  add('track', id, {
    name: mine ? doc.you.displayName : `Дорожка ${all.length + 1}`,
    color: mine ? doc.you.color : TRACK_COLORS[all.length % TRACK_COLORS.length],
    order, gain: 1, pan: 0, mute: false, solo: false, ownerId: mine ? doc.you.id : null, character: '', locked: false,
  }, { label: 'дорожка' });
  if (mine) arm(id);
}

async function renameTrack(t) {
  if (!canEdit()) return;
  const name = await prompt('Название дорожки', { value: t.name, ok: 'Сохранить' });
  if (name) update(t.id, { name });
}

function trackMenu(t, x, y) {
  const all = tracks();
  const i = all.findIndex(a => a.id === t.id);
  const clips = byKind('clip').filter(c => c.trackId === t.id);
  menu(x, y, [
    { label: 'Писать на эту дорожку', icon: 'mic', onClick: () => arm(t.id) },
    { label: 'Переименовать…', icon: 'edit', disabled: !canEdit(), onClick: () => renameTrack(t) },
    { label: t.ownerId === doc.you.id ? 'Это моя дорожка ✓' : 'Сделать моей', icon: 'user', disabled: !canEdit() || t.ownerId === doc.you.id, onClick: () => update(t.id, { ownerId: doc.you.id, color: doc.you.color }) },
    '-',
    { label: 'Выше', icon: 'up', disabled: !canEdit() || i === 0, onClick: () => swapOrder(t, all[i - 1]) },
    { label: 'Ниже', icon: 'down', disabled: !canEdit() || i === all.length - 1, onClick: () => swapOrder(t, all[i + 1]) },
    '-',
    { label: clips.length ? `Удалить дорожку и ${clips.length} клип.` : 'Удалить дорожку', icon: 'delete', danger: true, disabled: !canEdit(), onClick: () => {
      batch([...clips.map(c => ({ type: 'remove', id: c.id })), { type: 'remove', id: t.id }], { label: 'удаление дорожки' });
    } },
  ]);
}

function swapOrder(a, b) {
  batch([{ type: 'update', id: a.id, data: { order: b.order ?? 0 } }, { type: 'update', id: b.id, data: { order: a.order ?? 0 } }]);
}

// ---------- перетаскивание дублей из списка ----------
function onDragOver(e) {
  if (!e.dataTransfer.types.includes('application/x-jitdub-take')) return;
  e.preventDefault();
  el.lanesInner.querySelectorAll('.lane.drop').forEach(l => l.classList.remove('drop'));
  const r = el.lanesInner.getBoundingClientRect();
  const row = rowAt(e.clientY - r.top);
  if (row?.kind === 'track') el.lanesInner.querySelector(`.lane[data-row="${row.id}"]`)?.classList.add('drop');
}

function onDrop(e) {
  const takeId = e.dataTransfer.getData('application/x-jitdub-take');
  el.lanesInner.querySelectorAll('.lane.drop').forEach(l => l.classList.remove('drop'));
  if (!takeId || !canEdit()) return;
  e.preventDefault();
  const r = el.lanesInner.getBoundingClientRect();
  const row = rowAt(e.clientY - r.top);
  if (row?.kind !== 'track') return;
  const take = doc.takes.get(takeId);
  const id = uid('k');
  add('clip', id, { trackId: row.id, takeId, start: round(snapTime(timeAtClient(e.clientX), null)), offset: 0, duration: take?.duration || 1, gain: 1, fadeIn: 0, fadeOut: 0, name: take?.name || '', cueId: null, mute: false }, { label: 'клип' });
  select(id);
  el.snapline.style.display = 'none';
}

export function scrollToTime(t) {
  const x = t * pps;
  if (x < el.lanes.scrollLeft || x > el.lanes.scrollLeft + el.lanes.clientWidth - 40) el.lanes.scrollLeft = Math.max(0, x - el.lanes.clientWidth / 3);
}
