// Аудио-движок на WebAudio: загрузка и декодирование дублей, пики для волн, транспорт (часы — AudioContext,
// видео подстраивается под них), воспроизведение клипов с громкостью/паном/фейдами, запись с микрофона
// через AudioWorklet с точной привязкой к таймлайну, сведение в WAV (OfflineAudioContext).
import { doc, byKind, tracks, events as docEvents } from './sync.js';
import { api, prefs } from './api.js';
import { Emitter, debounce } from './util.js';

export const events = new Emitter();
let ctx = null;
let master = null;

export function audioCtx() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    master = ctx.createGain();
    master.gain.value = prefs.get('masterGain', 1);
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setMasterGain(v) { audioCtx(); master.gain.value = v; prefs.set('masterGain', v); }
export const masterGain = () => prefs.get('masterGain', 1);

// ---------- дубли ----------
const takeCache = new Map(); // takeId → { buffer, peaks } | Promise
const PEAK_STEP = 128;       // кадров на одну точку пиков

function computePeaks(buffer) {
  const n = Math.ceil(buffer.length / PEAK_STEP);
  const min = new Float32Array(n), max = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let lo = 1, hi = -1;
    const a = i * PEAK_STEP, b = Math.min(buffer.length, a + PEAK_STEP);
    for (const d of chans) for (let j = a; j < b; j++) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[i] = lo; max[i] = hi;
  }
  return { min, max, rate: buffer.sampleRate / PEAK_STEP };
}

export function takeData(id) {
  const v = takeCache.get(id);
  return v && !(v instanceof Promise) ? v : null;
}

export function loadTake(id) {
  const v = takeCache.get(id);
  if (v) return v instanceof Promise ? v : Promise.resolve(v);
  const p = (async () => {
    const r = await api(`/api/takes/${id}`, { raw: true });
    const ab = await r.arrayBuffer();
    const buffer = await audioCtx().decodeAudioData(ab);
    const entry = { buffer, peaks: computePeaks(buffer) };
    takeCache.set(id, entry);
    events.emit('take', id);
    return entry;
  })().catch(e => { takeCache.delete(id); throw e; });
  takeCache.set(id, p);
  return p;
}

// локально записанный дубль кладём в кэш сразу, без повторной загрузки
export function cacheTake(id, buffer) {
  takeCache.set(id, { buffer, peaks: computePeaks(buffer) });
  events.emit('take', id);
}

export function preloadAll() {
  for (const c of byKind('clip')) if (c.takeId && !takeCache.has(c.takeId)) loadTake(c.takeId).catch(() => {});
}

// ---------- транспорт ----------
const T = {
  playing: false,
  pos: 0,            // позиция, когда стоим
  startPos: 0,       // позиция в момент старта
  startCtx: 0,       // время контекста в момент старта
  sources: [],       // запущенные источники
  trackNodes: new Map(),
  video: null,
  loop: null,        // { a, b }
};

export const isPlaying = () => T.playing;
export const outLatency = () => (ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0);

export function position() {
  if (!T.playing) return T.pos;
  return T.startPos + Math.max(0, ctx.currentTime - T.startCtx);
}

export function setVideo(el) { T.video = el; }

export function projectEnd() {
  let end = doc.project?.video?.duration || 0;
  for (const it of doc.items.values()) {
    if (it.kind === 'clip') end = Math.max(end, it.start + it.duration);
    if (it.kind === 'cue') end = Math.max(end, it.end);
  }
  return Math.max(end, 30);
}

function playableTracks() {
  const all = tracks();
  const solo = all.some(t => t.solo);
  return new Set(all.filter(t => !t.mute && (!solo || t.solo)).map(t => t.id));
}

// громкость клипа в момент x (секунды от начала клипа) с учётом фейдов
function clipGainAt(c, x) {
  const g = c.gain ?? 1;
  let k = 1;
  if (c.fadeIn > 0 && x < c.fadeIn) k = Math.min(k, Math.max(0, x / c.fadeIn));
  if (c.fadeOut > 0 && x > c.duration - c.fadeOut) k = Math.min(k, Math.max(0, (c.duration - x) / c.fadeOut));
  return g * k;
}

// Ставит клип в контекст c: from — позиция таймлайна, соответствующая времени now; dest — узел дорожки
function scheduleClip(c, clip, buffer, from, now, dest) {
  const end = clip.start + clip.duration;
  if (end <= from || clip.mute) return null;
  const skip = Math.max(0, from - clip.start);
  const when = now + Math.max(0, clip.start - from);
  const off = (clip.offset || 0) + skip;
  const dur = clip.duration - skip;
  if (dur <= 0 || off >= buffer.duration) return null;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const g = c.createGain();
  // фейды: точки огибающей по времени контекста
  g.gain.setValueAtTime(clipGainAt(clip, skip), when);
  const pts = [];
  if (clip.fadeIn > 0 && skip < clip.fadeIn) pts.push(clip.fadeIn);
  if (clip.fadeOut > 0) { const fo = clip.duration - clip.fadeOut; if (fo > skip) pts.push(fo); pts.push(clip.duration); }
  for (const x of pts.sort((a, b) => a - b)) if (x > skip) g.gain.linearRampToValueAtTime(clipGainAt(clip, x), when + (x - skip));
  src.connect(g).connect(dest);
  src.start(when, off, dur);
  return src;
}

function trackNode(t) {
  let n = T.trackNodes.get(t.id);
  if (!n) {
    const gain = ctx.createGain(), pan = ctx.createStereoPanner();
    gain.connect(pan).connect(master);
    n = { gain, pan };
    T.trackNodes.set(t.id, n);
  }
  n.gain.gain.value = t.gain ?? 1;
  n.pan.pan.value = t.pan ?? 0;
  return n;
}

function stopSources() {
  for (const s of T.sources) { try { s.stop(); } catch {} s.disconnect(); }
  T.sources = [];
}

function scheduleAll() {
  stopSources();
  const now = Math.max(ctx.currentTime, T.startCtx);
  const from = position();
  const play = playableTracks();
  const tmap = new Map(tracks().map(t => [t.id, t]));
  for (const clip of byKind('clip')) {
    if (!play.has(clip.trackId) || clip.start + clip.duration <= from) continue;
    const data = takeData(clip.takeId);
    if (!data) { loadTake(clip.takeId).then(() => T.playing && reschedule()).catch(() => {}); continue; }
    const s = scheduleClip(ctx, clip, data.buffer, from, now, trackNode(tmap.get(clip.trackId)).gain);
    if (s) T.sources.push(s);
  }
}
const reschedule = debounce(() => { if (T.playing) scheduleAll(); }, 30);

export function play(from = position()) {
  audioCtx();
  T.startPos = Math.max(0, from);
  T.startCtx = ctx.currentTime + 0.06; // небольшой запас, чтобы первые клипы не обрезались
  T.playing = true;
  // источники ставим относительно startCtx: position() до него = startPos
  stopSources();
  const play = playableTracks();
  const tmap = new Map(tracks().map(t => [t.id, t]));
  for (const clip of byKind('clip')) {
    if (!play.has(clip.trackId)) continue;
    const data = takeData(clip.takeId);
    if (!data) { loadTake(clip.takeId).then(() => T.playing && reschedule()).catch(() => {}); continue; }
    const s = scheduleClip(ctx, clip, data.buffer, T.startPos, T.startCtx, trackNode(tmap.get(clip.trackId)).gain);
    if (s) T.sources.push(s);
  }
  if (T.video) {
    T.video.currentTime = Math.max(0, T.startPos - outLatency());
    T.video.playbackRate = 1;
    T.video.play().catch(() => {});
  }
  events.emit('transport');
  tick();
}

export function pause() {
  if (!T.playing) return;
  T.pos = position();
  T.playing = false;
  stopSources();
  if (T.video) { T.video.pause(); T.video.currentTime = T.pos; }
  if (rec.active) stopRecording();
  events.emit('transport');
}

export function toggle() { T.playing ? pause() : play(); }

export function seek(t) {
  t = Math.max(0, t);
  if (T.playing) { play(t); return; }
  T.pos = t;
  if (T.video) T.video.currentTime = t;
  events.emit('seek', t);
}

function tick() {
  if (!T.playing) return;
  const p = position();
  // видео — под часы аудио (с учётом выходной задержки, чтобы картинка совпадала со звуком в наушниках)
  const v = T.video;
  if (v && v.readyState >= 2 && !v.seeking) {
    const target = p - outLatency();
    const drift = v.currentTime - target;
    if (target > 0 && Math.abs(drift) > 0.25) v.currentTime = target;
    else if (Math.abs(drift) > 0.03) v.playbackRate = Math.min(1.05, Math.max(0.95, 1 - drift * 0.8));
    else v.playbackRate = 1;
    if (v.paused && target < v.duration) v.play().catch(() => {});
  }
  if (rec.active && rec.autoStop != null && p >= rec.autoStop) stopRecording();
  if (T.loop && p >= T.loop.b && !rec.active) { play(T.loop.a); return; }
  events.emit('tick', p);
  requestAnimationFrame(tick);
}

export function setLoop(a, b) { T.loop = a != null && b > a ? { a, b } : null; events.emit('transport'); }
export const loop = () => T.loop;

// изменения документа во время воспроизведения
docEvents.on('change', ch => {
  if (!ctx) return;
  if (ch.kinds.has('track')) for (const t of tracks()) if (T.trackNodes.has(t.id)) trackNode(t);
  if (T.playing && (ch.kinds.has('clip') || ch.kinds.has('track'))) reschedule();
});
docEvents.on('state', () => { if (T.playing) reschedule(); });

// ---------- вход (микрофон) и запись ----------
const rec = {
  stream: null, source: null, node: null, monitor: null, sink: null,
  active: false, chunks: [], punchCtx: 0, autoStop: null, trackId: null, cueId: null, peak: 0,
  doneResolve: null,
};
export const recording = () => (rec.active ? { trackId: rec.trackId, cueId: rec.cueId } : null);
export const inputOpen = () => !!rec.stream;

export async function listInputs() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'audioinput');
  } catch { return []; }
}

export async function openInput() {
  if (rec.stream) return;
  const c = audioCtx();
  const deviceId = prefs.get('inputDevice', '');
  rec.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
    },
  });
  await c.audioWorklet.addModule('js/rec-worklet.js').catch(() => {}); // повторная регистрация — ошибка, её глушим
  rec.source = c.createMediaStreamSource(rec.stream);
  rec.node = new AudioWorkletNode(c, 'jitdub-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  rec.sink = c.createGain(); rec.sink.gain.value = 0;
  rec.monitor = c.createGain(); rec.monitor.gain.value = prefs.get('monitor', false) ? 1 : 0;
  rec.source.connect(rec.node).connect(rec.sink).connect(c.destination);
  rec.source.connect(rec.monitor).connect(master);
  rec.node.port.onmessage = e => {
    const m = e.data;
    if (m.peak != null) { rec.peak = m.peak; events.emit('meter', m.peak); }
    if (m.data) rec.chunks.push(m);
    if (m.done && rec.doneResolve) { rec.doneResolve(); rec.doneResolve = null; }
  };
  rec.stream.getAudioTracks()[0]?.addEventListener('ended', closeInput);
  events.emit('input');
}

export function closeInput() {
  if (rec.active) stopRecording();
  rec.stream?.getTracks().forEach(t => t.stop());
  for (const n of [rec.source, rec.node, rec.monitor, rec.sink]) n?.disconnect();
  rec.stream = rec.source = rec.node = rec.monitor = rec.sink = null;
  events.emit('input');
  events.emit('meter', 0);
}

export function setMonitor(on) {
  prefs.set('monitor', !!on);
  if (rec.monitor) rec.monitor.gain.value = on ? 1 : 0;
}

export function latencySec() {
  const extra = Number(prefs.get('inputLatencyMs', 20)) / 1000;
  return outLatency() + extra;
}

// Запись: punchIn — позиция таймлайна, с которой сохраняем звук; воспроизведение начинается за preroll до неё.
export async function startRecording({ trackId, cueId = null, punchIn = position(), autoStop = null, preroll = 0 }) {
  if (rec.active) return;
  await openInput();
  rec.chunks = [];
  rec.trackId = trackId;
  rec.cueId = cueId;
  rec.autoStop = autoStop;
  rec.active = true;
  if (prefs.get('muteOriginalOnRec', false) && T.video) { rec.videoVol = T.video.muted; T.video.muted = true; }
  play(Math.max(0, punchIn - preroll));
  // кадр контекста, начиная с которого звук попадает в дубль
  rec.punchPos = punchIn;
  rec.punchCtx = T.startCtx + (punchIn - T.startPos);
  rec.node.port.postMessage({ rec: true });
  events.emit('record', recording());
}

// Останавливает запись, возвращает { buffer, wav, start, offset, duration, trackId, cueId } или null
export function stopRecording() {
  if (!rec.active) return Promise.resolve(null);
  rec.active = false;
  const info = { trackId: rec.trackId, cueId: rec.cueId };
  const done = new Promise(r => { rec.doneResolve = r; });
  rec.node.port.postMessage({ rec: false });
  if (T.video && rec.videoVol !== undefined) { T.video.muted = rec.videoVol; rec.videoVol = undefined; }
  events.emit('record', null);
  const result = (async () => {
    await Promise.race([done, new Promise(r => setTimeout(r, 500))]);
    if (T.playing) pause();
    const sr = ctx.sampleRate;
    const startFrame = Math.round(rec.punchCtx * sr);
    // склейка блоков, отрезаем всё до punchIn
    let total = 0;
    for (const ch of rec.chunks) total += Math.max(0, ch.frame + ch.data.length - Math.max(ch.frame, startFrame));
    if (total < sr * 0.05) return null; // меньше 50 мс — не дубль
    const pcm = new Float32Array(total);
    let w = 0, first = null;
    for (const ch of rec.chunks) {
      const from = Math.max(0, startFrame - ch.frame);
      if (from >= ch.data.length) continue;
      if (first == null) first = ch.frame + from;
      pcm.set(ch.data.subarray(from), w);
      w += ch.data.length - from;
    }
    rec.chunks = [];
    const buffer = ctx.createBuffer(1, pcm.length, sr);
    buffer.copyToChannel(pcm, 0);
    // позиция первого сэмпла на таймлайне минус задержка вход+выход
    const firstPos = rec.punchPos + (first / sr - rec.punchCtx) - latencySec();
    const offset = Math.max(0, -firstPos);
    return {
      ...info, buffer, wav: encodeWav([pcm], sr),
      start: Math.max(0, firstPos), offset, duration: buffer.duration - offset,
    };
  })();
  // результат обрабатывает приложение (загрузка дубля, клип), кто бы ни остановил запись
  result.then(r => r && events.emit('recorded', r), e => events.emit('error', e.message));
  return result;
}

// ---------- WAV ----------
export function encodeWav(channels, sr, bits = 16) {
  const n = channels[0].length, nc = channels.length, bps = bits / 8;
  const buf = new ArrayBuffer(44 + n * nc * bps);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nc * bps, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, n * nc * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const s = Math.max(-1, Math.min(1, channels[c][i]));
    if (bits === 24) {
      const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff); o += 3;
    } else {
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
  }
  return new Uint8Array(buf);
}

// ---------- сведение ----------
// trackIds — какие дорожки сводить (по умолчанию — слышимые с учётом mute/solo)
export async function mixdown({ trackIds = null, from = 0, to = null, bits = 16, onProgress } = {}) {
  audioCtx();
  const ids = trackIds ? new Set(trackIds) : playableTracks();
  const clips = byKind('clip').filter(c => ids.has(c.trackId) && !c.mute);
  const end = to ?? Math.max(0.5, ...clips.map(c => c.start + c.duration));
  let i = 0;
  for (const c of clips) { await loadTake(c.takeId); onProgress?.(++i / clips.length); }
  const sr = ctx.sampleRate;
  const off = new OfflineAudioContext(2, Math.ceil((end - from) * sr), sr);
  const nodes = new Map();
  for (const t of tracks()) {
    if (!ids.has(t.id)) continue;
    const g = off.createGain(), p = off.createStereoPanner();
    g.gain.value = t.gain ?? 1; p.pan.value = t.pan ?? 0;
    g.connect(p).connect(off.destination);
    nodes.set(t.id, g);
  }
  for (const c of clips) {
    const d = takeData(c.takeId);
    if (d && nodes.has(c.trackId)) scheduleClip(off, c, d.buffer, from, 0, nodes.get(c.trackId));
  }
  const out = await off.startRendering();
  return encodeWav([out.getChannelData(0), out.getChannelData(1)], sr, bits);
}
