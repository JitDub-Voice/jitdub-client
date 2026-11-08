// Видео-панель: видео проекта (с диска; можно загрузить на сервер, остальные скачают или смотрят онлайн),
// субтитр текущей реплики поверх кадра, индикатор записи и «лента ритмо» — реплики проезжают под видео
// справа налево через линию синхронизации, как в классическом дубляже.
import { h, fill, fmtTime, charColor, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { doc, events as docEvents, cues, op, canEdit } from './sync.js';
import * as audio from './audio.js';
import { prefs, isTauri, api, session } from './api.js';
import { toast, menu } from './kit.js';

let el = {};
let file = null;   // { name, size, path? , remote? }
let blob = null;   // перетащенный File (для загрузки на сервер, когда пути нет)
let url = null;
let upload = null;   // { received, total, cancelled }
let download = null; // { dest, received, total }

export function mountVideo(root) {
  el.video = h('video', { preload: 'auto', playsInline: true });
  el.video.volume = prefs.get('origVolume', 0.8); // пока звук не пущен через WebAudio
  el.input = h('input', { type: 'file', accept: 'video/*,.mkv,.mp4,.webm,.mov,.avi', style: { display: 'none' }, onchange: () => el.input.files[0] && openFile(el.input.files[0]) });
  el.drop = h('div.vdrop', {});
  el.sub = h('div.vsub');
  el.top = h('div.vtop');
  el.rec = h('div.vrec', {}, h('i'), 'ЗАПИСЬ');
  el.count = h('div.countdown');
  el.wrap = h('div.vwrap', {}, el.video, el.drop, el.sub, el.top, el.rec, el.count);
  el.rythmo = h('canvas');
  fill(root, el.wrap, h('div.rythmo', {}, el.rythmo), el.input);
  audio.setVideo(el.video);

  el.wrap.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); el.drop.classList.add('over'); } });
  el.wrap.addEventListener('dragleave', () => el.drop.classList.remove('over'));
  el.wrap.addEventListener('drop', e => {
    e.preventDefault();
    el.drop.classList.remove('over');
    const f = [...e.dataTransfer.files][0];
    if (!f) return;
    if (/\.(srt|ass|ssa|vtt)$/i.test(f.name)) window.dispatchEvent(new CustomEvent('jitdub:importSubs', { detail: f }));
    else openFile(f);
  });
  el.video.addEventListener('loadedmetadata', onMeta);
  el.video.addEventListener('error', () => { if (file) toast(`Не удалось открыть видео «${file.name}» — WebView поддерживает MP4 (H.264/AAC) и WebM; MKV/HEVC перекодируйте`, 'err', 7000); });

  docEvents.on('state', () => { autoOpen(); render(); });
  docEvents.on('change', ch => { if (ch.project || ch.kinds.has('cue')) render(); });
  audio.events.on('tick', onTick);
  audio.events.on('seek', onTick);
  audio.events.on('record', r => el.rec.classList.toggle('on', !!r));
  audio.events.on('original', render);
  new ResizeObserver(() => drawRythmo(audio.position())).observe(el.rythmo);
  if (isTauri) window.__TAURI__.event.listen('jitdub-download', onDownloadEvent);
  render();
}

// В приложении — системный диалог: он отдаёт путь, видео идёт с диска по jdmedia:// и открывается само
// при следующем запуске. В браузере (npm run web) — обычный выбор файла, без запоминания.
export async function pickVideo() {
  if (!isTauri) { el.input.value = ''; el.input.click(); return; }
  try {
    const info = await window.__TAURI__.core.invoke('pick_video');
    if (info) openPath(info);
  } catch (e) { toast(`Не удалось открыть видео: ${e}`, 'err'); }
}

const isWin = navigator.userAgent.includes('Windows');
const mediaUrl = path => (isWin ? `http://jdmedia.localhost/${encodeURIComponent(path)}` : `jdmedia://localhost/${encodeURIComponent(path)}`);

function setSource(meta, src, fileBlob = null) {
  file = meta;
  blob = fileBlob;
  if (url) { URL.revokeObjectURL(url); url = null; }
  if (src.startsWith('blob:')) url = src;
  el.video.crossOrigin = 'anonymous'; // звук пойдёт через WebAudio — нужен CORS
  el.video.src = src;
  if (doc.project && !meta.remote) prefs.set('video.' + doc.project.id, meta);
  render();
}

function openPath(info) {
  setSource({ name: info.name, size: info.size, path: info.path }, mediaUrl(info.path));
}

// перетащенный файл: WebView не сообщает путь, поэтому такое видео не запомнится между запусками
function openFile(f) {
  setSource({ name: f.name, size: f.size }, URL.createObjectURL(f), f);
  if (isTauri) toast('Видео открыто. Чтобы оно открывалось само при следующем запуске, выберите его кнопкой «Открыть видео» (папка)', 'info', 6000);
}

// при входе в проект: закрыть видео прошлого проекта и открыть запомненное, если файл на месте
let shownProject = null;
async function autoOpen() {
  const id = doc.project?.id;
  if (!id || id === shownProject) return;
  shownProject = id;
  if (file) { el.video.removeAttribute('src'); el.video.load(); file = null; if (url) { URL.revokeObjectURL(url); url = null; } }
  render();
  const saved = prefs.get('video.' + id, null);
  if (!isTauri) return;
  try {
    if (saved?.path) {
      const info = await window.__TAURI__.core.invoke('file_info', { path: saved.path });
      if (doc.project?.id !== id) return;
      if (info) return openPath(info);
      toast(`Видео проекта не найдено по старому пути: ${saved.path}`, 'warn', 6000);
    }
    // уже скачано с сервера раньше?
    const pv = doc.project.video || {};
    if (pv.stored && pv.name) {
      const dest = await window.__TAURI__.core.invoke('media_dest', { folder: doc.project.name, name: pv.name });
      const info = await window.__TAURI__.core.invoke('file_info', { path: dest });
      if (doc.project?.id === id && info && info.size === pv.size) openPath(info);
    }
  } catch {}
}

// ---------- видео на сервере ----------
const CHUNK = 8 * 1024 * 1024;
const serverVideoUrl = (withToken = true) => `${session.server}/api/projects/${doc.project.id}/video${withToken ? `?token=${encodeURIComponent(session.token)}` : ''}`;

async function readChunk(a, b) {
  if (blob) return blob.slice(a, b);
  // файл с диска — тем же протоколом jdmedia:// по кускам
  const r = await fetch(mediaUrl(file.path), { headers: { Range: `bytes=${a}-${b - 1}` } });
  if (!r.ok) throw new Error(`чтение файла: ${r.status}`);
  return r.blob();
}

export async function uploadVideo() {
  if (!file || upload || file.remote) return;
  if (!blob && !file.path) return toast('Откройте видео кнопкой «Выбрать файл…», чтобы загрузить его', 'warn');
  const projectId = doc.project.id;
  const total = file.size;
  upload = { received: 0, total, cancelled: false };
  render();
  try {
    let { received } = await api(`/api/projects/${projectId}/video/upload`);
    if (received > total) received = 0;
    upload.received = received;
    while (received < total) {
      if (upload.cancelled) throw new Error('загрузка отменена');
      const end = Math.min(total, received + CHUNK);
      const body = await readChunk(received, end);
      try {
        ({ received } = await api(`/api/projects/${projectId}/video/upload?offset=${received}`, {
          method: 'PUT', body, headers: { 'content-type': 'application/octet-stream', 'x-total-size': String(total) },
        }));
      } catch (e) {
        if (e.status === 409) { ({ received } = await api(`/api/projects/${projectId}/video/upload`)); continue; }
        throw e;
      }
      upload.received = received;
      renderUpload();
    }
    await api(`/api/projects/${projectId}/video/complete`, {
      method: 'POST', body: { name: file.name, size: total, duration: el.video.duration || 0, fps: doc.project.video?.fps || 0 },
    });
    toast('Видео загружено на сервер — участники смогут скачать его', 'ok', 4000);
  } catch (e) {
    if (!/отменена/.test(e.message)) toast(`Загрузка видео: ${e.message}. Нажмите ещё раз — докачается`, 'err', 6000);
  } finally {
    upload = null;
    render();
  }
}

async function downloadVideo() {
  const pv = doc.project.video;
  if (!isTauri) return streamVideo();
  try {
    const dest = await window.__TAURI__.core.invoke('media_dest', { folder: doc.project.name, name: pv.name });
    const info = await window.__TAURI__.core.invoke('file_info', { path: dest });
    if (info && info.size === pv.size) return openPath(info);
    download = { dest, received: 0, total: pv.size };
    render();
    await window.__TAURI__.core.invoke('download_media', { url: serverVideoUrl(false), token: session.token, dest });
  } catch (e) { download = null; render(); toast(`Скачивание: ${e}`, 'err'); }
}

function streamVideo() {
  const pv = doc.project.video;
  setSource({ name: pv.name, size: pv.size, remote: true }, serverVideoUrl());
}

function onDownloadEvent(e) {
  const d = e.payload;
  if (!download || d.dest !== download.dest) return;
  if (d.error) {
    download = null; render();
    if (d.error !== 'отменено') toast(`Скачивание видео: ${d.error}`, 'err', 6000);
    return;
  }
  download.received = d.received; download.total = d.total || download.total;
  if (d.done) {
    download = null;
    window.__TAURI__.core.invoke('file_info', { path: d.dest }).then(info => info && openPath(info));
    toast('Видео скачано', 'ok', 2500);
  }
  renderUpload();
}

const pct = (a, b) => (b ? Math.floor((a / b) * 100) : 0);

// прогресс обновляем точечно, без перерисовки всей панели
function renderUpload() {
  const u = upload || download;
  for (const n of document.querySelectorAll('.vprog')) {
    n.querySelector('i').style.width = pct(u?.received, u?.total) + '%';
    n.querySelector('span').textContent = u ? `${pct(u.received, u.total)}% · ${fmtBytes(u.received)} из ${fmtBytes(u.total)}` : '';
  }
}

function onMeta() {
  const v = doc.project?.video || {};
  const meta = { name: file.name, size: file.size, duration: el.video.duration, fps: v.fps || 0 };
  if (!v.name && canEdit()) op({ type: 'project', data: { video: meta } }, { undoable: false });
  else if (v.name && (v.size !== file.size || Math.abs((v.duration || 0) - el.video.duration) > 0.5)) {
    toast(`Это видео отличается от проектного (${v.name}, ${fmtBytes(v.size || 0)}). Тайминги реплик могут не совпасть.`, 'warn', 7000);
  }
  el.video.currentTime = audio.position();
  audio.attachOriginal(); // звук оригинала — через движок: громкость, закадр/дубляж под озвучкой
  render();
  docEvents.emit('videoLoaded');
}

function render() {
  if (!el.top) return;
  const pv = doc.project?.video || {};
  const has = !!file;
  el.drop.style.display = has ? 'none' : '';
  const last = doc.project ? prefs.get('video.' + doc.project.id, null) : null;
  const prog = h('div.vprog', {}, h('div.bar', {}, h('i')), h('span'));
  fill(el.drop,
    icon('film', { size: 32 }),
    h('b', {}, download ? 'Скачиваю видео проекта…' : pv.stored ? 'Видео проекта на сервере' : pv.name ? 'Откройте видео проекта' : 'Перетащите видео сюда'),
    pv.name ? h('span', {}, `${pv.name} · ${fmtBytes(pv.size || 0)} · ${fmtTime(pv.duration || 0, false)}`) : h('span', {}, 'MP4 (H.264) или WebM. Потом его можно загрузить на сервер — участники скачают в один клик.'),
    last && last.name !== pv.name ? h('span.dim', {}, `в прошлый раз: ${last.name}`) : null,
    download ? prog : null,
    download ? h('div.row', {}, h('button.ui-btn.secondary', { onclick: () => window.__TAURI__.core.invoke('cancel_download', { dest: download.dest }) }, 'Отменить')) : null,
    !download && pv.stored ? h('div.row', {},
      isTauri ? h('button.ui-btn.primary', { onclick: downloadVideo, 'data-tip': 'Скачать в «Видео\\JitDub» — потом откроется само' }, icon('download'), `Скачать (${fmtBytes(pv.size || 0)})`) : null,
      h(`button.ui-btn.${isTauri ? 'secondary' : 'primary'}`, { onclick: streamVideo, 'data-tip': 'Смотреть прямо с сервера, без скачивания' }, icon('play'), 'Смотреть онлайн')) : null,
    !download ? h('div.row', {}, h(`button.ui-btn.${pv.stored ? 'secondary' : 'primary'}`, { onclick: pickVideo }, icon('folder'), pv.stored ? 'У меня есть своя копия…' : 'Выбрать файл…')) : null,
    h('span.dim', { style: { fontSize: '12px' } }, 'Сюда же можно перетащить субтитры .ass / .srt — они станут репликами'));
  renderUpload();
  const mismatch = has && pv.name && pv.size && pv.size !== file.size;
  const muted = prefs.get('origMuted', false);
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: prefs.get('origVolume', 0.8), style: { width: '80px' }, 'data-tip': 'Громкость оригинала' });
  vol.addEventListener('input', () => audio.setOrigVolume(+vol.value));
  vol.addEventListener('dblclick', () => { vol.value = 0.8; audio.setOrigVolume(0.8); });
  const muteBtn = h(`button.ui-ib${muted ? '.on' : ''}`, {
    'data-tip': 'Звук оригинала вкл/выкл', onclick: () => { audio.setOrigMuted(!muted); render(); },
  }, icon(muted ? 'hide' : 'headphones'));
  const mode = audio.duckMode();
  const modeBtn = h('button.pill.duck', {
    'data-tip': 'Что делать с оригиналом, когда звучит озвучка (D — переключить)',
    onclick: e => menu(e.clientX, e.clientY, Object.entries(audio.DUCK_MODES).map(([k, label]) => ({ label, icon: k === mode ? 'check' : null, onClick: () => { audio.setDuckMode(k); render(); } }))),
  }, { off: 'Оригинал как есть', duck: 'Закадр', cut: 'Дубляж' }[mode], icon('down', { size: 14 }));
  // статус видео на сервере
  const cloud = !has ? null
    : upload ? h('span.pill.vprog', {}, h('div.bar', {}, h('i')), h('span'), h('button.ui-ib', { 'data-tip': 'Отменить загрузку', onclick: () => { upload.cancelled = true; } }, icon('closeSmall', { size: 14 })))
    : file.remote ? h('span.pill', { 'data-tip': 'Видео играет с сервера. Чтобы перемотка была мгновенной — скачайте его' }, icon('download', { size: 14 }), isTauri ? h('a', { onclick: downloadVideo }, 'онлайн · скачать') : 'онлайн')
    : pv.stored ? h('span.pill', { 'data-tip': 'Видео загружено на сервер — участники могут его скачать' }, icon('check', { size: 14 }), 'на сервере')
    : canEdit() ? h('button.pill.up', { onclick: uploadVideo, 'data-tip': 'Загрузить видео на сервер, чтобы участники скачали его в один клик' }, icon('upload', { size: 14 }), 'Загрузить на сервер')
    : null;
  fill(el.top,
    has ? h(`span.pill${mismatch ? '.warn' : ''}`, { title: file.name }, icon(mismatch ? 'warning' : 'film', { size: 14 }), file.name.length > 40 ? file.name.slice(0, 38) + '…' : file.name) : null,
    cloud,
    h('span.grow'),
    has ? modeBtn : null,
    has ? h('span.pill', {}, 'Оригинал', vol) : null,
    has ? muteBtn : null,
    has ? h('button.ui-ib', { 'data-tip': 'Открыть другое видео', onclick: pickVideo }, icon('folder')) : null);
  onTick(audio.position());
}

function currentCue(t) {
  let cur = null;
  for (const q of cues()) { if (q.start <= t && q.end > t) { cur = q; break; } }
  return cur;
}

let lastCueId = null;
function onTick(t) {
  const q = currentCue(t);
  if ((q?.id || null) !== lastCueId || q?.text !== el.sub.dataset.text) {
    lastCueId = q?.id || null;
    el.sub.dataset.text = q?.text || '';
    fill(el.sub, q && prefs.get('showSubs', true) ? h('div', {},
      q.character ? h('span.who', { style: { color: charColor(q.character) } }, q.character) : null,
      h('span.ln', {}, q.text)) : null);
  }
  drawRythmo(t);
}

export function countdown(n) {
  el.count.textContent = n > 0 ? String(n) : '';
  el.count.classList.toggle('on', n > 0);
}

// Лента ритмо: 1 секунда = SPAN px, линия синхронизации на 25% ширины
function drawRythmo(t) {
  const cv = el.rythmo;
  if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const SPAN = prefs.get('rythmoSpeed', 160);
  const X0 = Math.round(W * 0.25);
  const t0 = t - X0 / SPAN, t1 = t + (W - X0) / SPAN;
  g.font = '600 15px Inter, "Segoe UI", sans-serif';
  g.textBaseline = 'middle';
  const myId = doc.you?.id;
  for (const q of cues()) {
    if (q.end < t0 || q.start > t1) continue;
    const x = X0 + (q.start - t) * SPAN, w = (q.end - q.start) * SPAN;
    const col = charColor(q.character);
    const mine = q.assigneeId === myId;
    g.globalAlpha = mine ? 1 : 0.55;
    g.fillStyle = col + '26';
    g.fillRect(x, 6, w, H - 12);
    g.fillStyle = col;
    g.fillRect(x, 6, 2, H - 12);
    // текст растянут по длительности реплики — где буква, там и звук
    const text = (q.character ? q.character + ': ' : '') + q.text.replace(/\s+/g, ' ');
    const tw = g.measureText(text).width;
    g.save();
    g.beginPath(); g.rect(x, 0, w, H); g.clip();
    g.fillStyle = mine ? '#fff' : '#cfd2d8';
    if (tw > w - 8 && tw > 0) {
      g.translate(x + 4, H / 2);
      g.scale((w - 8) / tw, 1);
      g.fillText(text, 0, 0);
    } else {
      g.fillText(text, x + 4, H / 2);
    }
    g.restore();
  }
  g.globalAlpha = 1;
  g.fillStyle = audio.recording() ? '#E5484D' : '#ffffff';
  g.fillRect(X0 - 1, 0, 2, H);
}

export const videoEl = () => el.video;
export const hasVideo = () => !!file;
