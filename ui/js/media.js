// Дорожки видео на таймлайне: раскадровка (кадры видео по времени) и волна звука оригинала.
// Всё считается в фоне на этом компьютере из того же файла/потока, что играет в плеере.
import { Emitter } from './util.js';
import * as audio from './audio.js';

export const events = new Emitter();
export const media = {
  key: null,        // какое видео разобрано
  duration: 0,
  thumbs: [],       // ImageBitmap | undefined по индексу i → время i * step
  step: 2,
  thumbW: 72, thumbH: 40,
  peaks: null,      // { min, max, rate }
  audioState: '',   // '' | 'loading' | 'ok' | 'none'
};

let job = 0;

export function clearMedia() {
  job++;
  for (const b of media.thumbs) b?.close?.();
  Object.assign(media, { key: null, duration: 0, thumbs: [], peaks: null, audioState: '' });
  audio.setOriginalBuffer(null);
  events.emit('change');
}

// src — адрес видео (jdmedia/blob/сервер), key — имя+размер, size — байт (для решения, тянуть ли звук целиком)
export function loadMedia(src, key, duration, size = 0) {
  if (!src || media.key === key) return;
  clearMedia();
  const my = ++job;
  media.key = key;
  media.duration = duration || 0;
  // шаг раскадровки: не больше ~600 кадров на видео
  media.step = Math.max(1, Math.ceil((media.duration || 60) / 600));
  events.emit('change');
  setTimeout(() => { if (my === job) thumbsJob(src, my); }, 1500);
  setTimeout(() => { if (my === job) audioJob(src, my, size); }, 2500);
}

// кадры: отдельный скрытый <video>, перематываем по шагам и снимаем уменьшенный кадр
async function thumbsJob(src, my) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'; v.playsInline = true;
  v.src = src;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video')); });
  } catch { return; }
  const dur = v.duration || media.duration;
  media.duration ||= dur;
  const n = Math.ceil(dur / media.step);
  const ar = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
  media.thumbW = Math.round(media.thumbH * ar);
  const cv = document.createElement('canvas');
  cv.width = media.thumbW * 2; cv.height = media.thumbH * 2;
  const g = cv.getContext('2d');
  // порядок: сначала грубо (каждый 8-й), потом гуще — раскадровка появляется сразу по всей длине
  const order = [];
  const seen = new Set();
  for (const s of [8, 4, 2, 1]) for (let i = 0; i < n; i += s) if (!seen.has(i)) { seen.add(i); order.push(i); }
  let last = performance.now();
  for (const i of order) {
    if (my !== job) { v.removeAttribute('src'); v.load(); return; }
    const t = Math.min(dur - 0.05, i * media.step + media.step / 2);
    try {
      await new Promise((res, rej) => {
        const to = setTimeout(res, 3000);
        v.onseeked = () => { clearTimeout(to); res(); };
        v.onerror = () => { clearTimeout(to); rej(); };
        v.currentTime = t;
      });
      g.drawImage(v, 0, 0, cv.width, cv.height);
      media.thumbs[i] = await createImageBitmap(cv);
    } catch { continue; }
    if (performance.now() - last > 250) { last = performance.now(); events.emit('change'); }
    // не забиваем поток: даём плееру и интерфейсу дышать
    if (!audio.isPlaying()) await new Promise(r => setTimeout(r, 4));
    else await new Promise(r => setTimeout(r, 60));
  }
  v.removeAttribute('src'); v.load();
  events.emit('change');
}

// звук: файл целиком → декодирование в 16 кГц → моно. Из него — волна (100 точек/с) и скраб.
const MAX_AUDIO_BYTES = 2.5 * 1024 ** 3;
async function audioJob(src, my, size) {
  if (size > MAX_AUDIO_BYTES) { media.audioState = 'none'; events.emit('change'); return; }
  media.audioState = 'loading';
  events.emit('change');
  try {
    const ab = await fetchWhole(src, size, () => my !== job);
    if (!ab || my !== job) return;
    const SR = 16000;
    const dec = await new OfflineAudioContext(1, 1, SR).decodeAudioData(ab);
    if (my !== job) return;
    const n = dec.length, nc = dec.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < nc; c++) { const d = dec.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / nc; }
    const buf = audio.audioCtx().createBuffer(1, n, SR);
    buf.copyToChannel(mono, 0);
    const STEP = 160; // 100 точек в секунду
    const m = Math.ceil(n / STEP);
    const min = new Float32Array(m), max = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      let lo = 0, hi = 0;
      const a = i * STEP, b = Math.min(n, a + STEP);
      for (let j = a; j < b; j++) { const v = mono[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      min[i] = lo; max[i] = hi;
    }
    media.peaks = { min, max, rate: SR / STEP };
    media.audioState = 'ok';
    audio.setOriginalBuffer(buf);
  } catch (e) {
    console.warn('звук оригинала для таймлайна:', e);
    if (my === job) media.audioState = 'none';
  }
  if (my === job) events.emit('change');
}

// Файл целиком. Локальное видео (jdmedia) и сервер без Range отдают только первый кусок,
// поэтому качаем явными диапазонами по 16 МБ и складываем в один буфер.
async function fetchWhole(src, size, cancelled) {
  if (src.startsWith('blob:')) return (await fetch(src)).arrayBuffer();
  const STEP = 16 * 1024 * 1024;
  const parts = [];
  let got = 0;
  for (;;) {
    if (cancelled()) return null;
    const end = size ? Math.min(size, got + STEP) - 1 : got + STEP - 1;
    const r = await fetch(src, { headers: { Range: `bytes=${got}-${end}` } });
    if (r.status === 416) break;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = new Uint8Array(await r.arrayBuffer());
    if (r.status === 200) return b.buffer; // сервер отдал весь файл сразу
    parts.push(b);
    got += b.length;
    if (!b.length || (size && got >= size) || (!size && b.length < end - (got - b.length) + 1)) break;
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

// кадр для момента t (ближайший готовый)
export function thumbAt(t) {
  const i = Math.floor(t / media.step);
  if (media.thumbs[i]) return media.thumbs[i];
  for (let d = 1; d < 16; d++) {
    if (media.thumbs[i - d]) return media.thumbs[i - d];
    if (media.thumbs[i + d]) return media.thumbs[i + d];
  }
  return null;
}
