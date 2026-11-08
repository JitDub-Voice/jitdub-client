// Видео-панель: локальный файл видео (у каждого участника свой, сверяется по имени и размеру),
// субтитр текущей реплики поверх кадра, индикатор записи и «лента ритмо» — реплики проезжают под видео
// справа налево через линию синхронизации, как в классическом дубляже.
import { h, fill, fmtTime, charColor, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { doc, events as docEvents, cues, op, canEdit } from './sync.js';
import * as audio from './audio.js';
import { prefs } from './api.js';
import { toast } from './kit.js';

let el = {};
let file = null;
let url = null;

export function mountVideo(root) {
  el.video = h('video', { preload: 'auto', playsInline: true });
  el.video.volume = prefs.get('origVolume', 0.8);
  el.video.muted = prefs.get('origMuted', false);
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

  docEvents.on('state', render);
  docEvents.on('change', ch => { if (ch.project || ch.kinds.has('cue')) render(); });
  audio.events.on('tick', onTick);
  audio.events.on('seek', onTick);
  audio.events.on('record', r => el.rec.classList.toggle('on', !!r));
  new ResizeObserver(() => drawRythmo(audio.position())).observe(el.rythmo);
  render();
}

export function pickVideo() { el.input.value = ''; el.input.click(); }

function openFile(f) {
  file = f;
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(f);
  el.video.src = url;
  // запоминаем, какой файл открывали для проекта (имя — для подсказки при следующем запуске)
  if (doc.project) prefs.set('video.' + doc.project.id, { name: f.name, size: f.size });
  render();
}

function onMeta() {
  const v = doc.project?.video || {};
  const meta = { name: file.name, size: file.size, duration: el.video.duration, fps: v.fps || 0 };
  if (!v.name && canEdit()) op({ type: 'project', data: { video: meta } }, { undoable: false });
  else if (v.name && (v.size !== file.size || Math.abs((v.duration || 0) - el.video.duration) > 0.5)) {
    toast(`Это видео отличается от проектного (${v.name}, ${fmtBytes(v.size || 0)}). Тайминги реплик могут не совпасть.`, 'warn', 7000);
  }
  el.video.currentTime = audio.position();
  render();
  docEvents.emit('videoLoaded');
}

function render() {
  if (!el.top) return;
  const pv = doc.project?.video || {};
  const has = !!file;
  el.drop.style.display = has ? 'none' : '';
  const last = doc.project ? prefs.get('video.' + doc.project.id, null) : null;
  fill(el.drop,
    icon('film', { size: 32 }),
    h('b', {}, pv.name ? 'Откройте видео проекта' : 'Перетащите видео сюда'),
    pv.name ? h('span', {}, `${pv.name} · ${fmtBytes(pv.size || 0)} · ${fmtTime(pv.duration || 0, false)}`) : h('span', {}, 'MP4 (H.264) или WebM. Видео остаётся на вашем компьютере — каждый участник открывает свою копию.'),
    last && last.name !== pv.name ? h('span.dim', {}, `в прошлый раз: ${last.name}`) : null,
    h('div.row', {}, h('button.ui-btn.primary', { onclick: pickVideo }, icon('folder'), 'Выбрать файл…')),
    h('span.dim', { style: { fontSize: '12px' } }, 'Сюда же можно перетащить субтитры .ass / .srt — они станут репликами'));
  const mismatch = has && pv.name && pv.size && pv.size !== file.size;
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: el.video.volume, style: { width: '80px' }, 'data-tip': 'Громкость оригинала' });
  vol.addEventListener('input', () => { el.video.volume = +vol.value; prefs.set('origVolume', +vol.value); });
  const muteBtn = h(`button.ui-ib${el.video.muted ? '.on' : ''}`, {
    'data-tip': 'Звук оригинала', onclick: () => { el.video.muted = !el.video.muted; prefs.set('origMuted', el.video.muted); render(); },
  }, icon(el.video.muted ? 'hide' : 'headphones'));
  fill(el.top,
    has ? h(`span.pill${mismatch ? '.warn' : ''}`, { title: file.name }, icon(mismatch ? 'warning' : 'film', { size: 14 }), file.name.length > 40 ? file.name.slice(0, 38) + '…' : file.name) : null,
    h('span.grow'),
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
