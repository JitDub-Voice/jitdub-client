// Документ проекта и его синхронизация через WebSocket (модель «как в Figma»):
// локальная операция применяется сразу (оптимистично) и уходит на сервер; сервер упорядочивает операции
// и рассылает всем. Пришедшая чужая операция применяется поверх подтверждённого состояния, затем заново
// накладываются свои неподтверждённые — поэтому у всех сходится одно и то же состояние.
import { Emitter, throttle } from './util.js';
import { wsUrl, api } from './api.js';

export const events = new Emitter();

export const doc = {
  project: null,
  items: new Map(),    // id → { id, kind, ...поля }
  members: new Map(),  // userId → { id, displayName, color, role }
  takes: new Map(),    // takeId → { id, userId, duration, mime, size, name, createdAt }
  messages: [],
  online: new Map(),   // sid → { sid, userId, presence }
  you: null,           // { id, displayName, color, role, sid }
  status: 'offline',   // offline | connecting | online
  rev: 0,
};

export const byKind = kind => [...doc.items.values()].filter(i => i.kind === kind);
export const tracks = () => byKind('track').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
export const cues = () => byKind('cue').sort((a, b) => a.start - b.start);
export const clipsOf = trackId => byKind('clip').filter(c => c.trackId === trackId);
export const member = id => doc.members.get(id);
export const canEdit = () => doc.you && doc.you.role !== 'viewer';

// ---------- применение операций к локальному документу ----------
function applyOp(op, changed) {
  switch (op.type) {
    case 'add': {
      doc.items.set(op.id, { id: op.id, kind: op.kind, ...op.data });
      changed.ids.add(op.id); changed.kinds.add(op.kind);
      break;
    }
    case 'update': {
      const it = doc.items.get(op.id);
      if (!it) break;
      Object.assign(it, op.data);
      changed.ids.add(op.id); changed.kinds.add(it.kind);
      break;
    }
    case 'remove': {
      const it = doc.items.get(op.id);
      if (!it) break;
      doc.items.delete(op.id);
      changed.ids.add(op.id); changed.kinds.add(it.kind); changed.removed.add(op.id);
      break;
    }
    case 'batch':
      for (const o of op.ops) applyOp(o, changed);
      break;
    case 'project': {
      // видео сливаем, как и сервер: его поля (stored и т.п.) не затираются метаданными клиента
      const { video, ...rest } = op.data;
      Object.assign(doc.project, rest);
      if (video) doc.project.video = { ...(doc.project.video || {}), ...video };
      changed.project = true;
      break;
    }
  }
}

const newChanged = () => ({ ids: new Set(), kinds: new Set(), removed: new Set(), project: false });

// Обратная операция (для отмены) — вычисляется до применения
function inverse(op) {
  switch (op.type) {
    case 'add': return { type: 'remove', id: op.id };
    case 'remove': {
      const it = doc.items.get(op.id);
      if (!it) return null;
      const { id, kind, ...data } = it;
      return { type: 'add', kind, id, data: structuredClone(data) };
    }
    case 'update': {
      const it = doc.items.get(op.id);
      if (!it) return null;
      const data = {};
      for (const k of Object.keys(op.data)) data[k] = it[k] === undefined ? null : structuredClone(it[k]);
      return { type: 'update', id: op.id, data };
    }
    case 'batch': {
      // обратные считаем последовательно на временной копии состояния
      const inv = [];
      const backup = new Map();
      for (const o of op.ops) {
        const i = inverse(o);
        if (i) inv.unshift(i);
        if (o.id && !backup.has(o.id)) backup.set(o.id, doc.items.has(o.id) ? structuredClone(doc.items.get(o.id)) : null);
        applyOp(o, newChanged());
      }
      for (const [id, v] of backup) v ? doc.items.set(id, v) : doc.items.delete(id);
      return inv.length ? { type: 'batch', ops: inv } : null;
    }
    case 'project': {
      const data = {};
      for (const k of Object.keys(op.data)) data[k] = structuredClone(doc.project[k] ?? null);
      return { type: 'project', data };
    }
  }
  return null;
}

// ---------- соединение ----------
let ws = null;
let projectId = null;
let cidSeq = 0;
let pending = [];      // [{ cid, op, sent }]
let retry = 0;
let retryTimer = null;
let pingTimer = null;
const undoStack = [];
const redoStack = [];

function setStatus(s) {
  doc.status = s;
  events.emit('status', s);
}

export function connect(id) {
  disconnect();
  projectId = id;
  open();
}

export function disconnect() {
  projectId = null;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  pending = [];
  undoStack.length = redoStack.length = 0;
  doc.project = null;
  doc.items.clear(); doc.members.clear(); doc.takes.clear(); doc.online.clear();
  doc.messages = [];
  setStatus('offline');
}

function open() {
  if (!projectId) return;
  setStatus('connecting');
  const sock = new WebSocket(wsUrl(projectId));
  ws = sock;
  sock.onopen = () => { retry = 0; };
  sock.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  sock.onclose = e => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    doc.online.clear();
    events.emit('online');
    setStatus('offline');
    if ([4001, 4003, 4004].includes(e.code)) { events.emit('fatal', e.reason || 'соединение закрыто сервером'); return; }
    retryTimer = setTimeout(open, Math.min(10000, 800 * 2 ** retry++));
  };
}

function send(msg) {
  if (ws?.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

function onMessage(m) {
  switch (m.t) {
    case 'hello': {
      const s = m.state;
      doc.you = m.you;
      doc.project = s.project;
      doc.rev = s.project.rev;
      doc.items = new Map(s.items.map(i => [i.id, i]));
      doc.members = new Map(s.members.map(u => [u.id, u]));
      doc.takes = new Map(s.takes.map(t => [t.id, t]));
      doc.messages = s.messages;
      doc.online = new Map(m.online.map(o => [o.sid, o]));
      // свои неподтверждённые операции — поверх свежего состояния и заново на сервер
      for (const p of pending) { applyOp(p.op, newChanged()); p.sent = send({ t: 'op', op: p.op, cid: p.cid }); }
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ t: 'ping' }), 20000);
      setStatus('online');
      events.emit('state');
      break;
    }
    case 'op': {
      const changed = newChanged();
      applyOp(m.op, changed);
      doc.rev = m.rev;
      if (m.sid === doc.you?.sid && m.cid != null) pending = pending.filter(p => p.cid !== m.cid);
      for (const p of pending) applyOp(p.op, changed);
      changed.by = m.by;
      events.emit('change', changed);
      break;
    }
    case 'ack':
      pending = pending.filter(p => p.cid !== m.cid);
      break;
    case 'nack': {
      pending = pending.filter(p => p.cid !== m.cid);
      events.emit('error', `сервер отклонил изменение: ${m.error}`);
      resync();
      break;
    }
    case 'presence': {
      const o = doc.online.get(m.sid) || { sid: m.sid, userId: m.userId, presence: {} };
      const { t, sid, userId, ...p } = m;
      Object.assign(o.presence, p);
      doc.online.set(m.sid, o);
      events.emit('presence', o);
      break;
    }
    case 'joined':
      doc.online.set(m.sid, { sid: m.sid, userId: m.userId, presence: {} });
      if (!doc.members.has(m.userId)) doc.members.set(m.userId, { ...m.user, role: 'editor' });
      events.emit('online');
      break;
    case 'left':
      doc.online.delete(m.sid);
      events.emit('online');
      break;
    case 'member':
      doc.members.set(m.member.id, m.member);
      events.emit('members');
      break;
    case 'profile': {
      // участник сменил имя или аватарку — роль в проекте сохраняем
      const u = doc.members.get(m.user.id);
      doc.members.set(m.user.id, { ...(u || { role: 'editor' }), ...m.user });
      if (doc.you?.id === m.user.id) Object.assign(doc.you, m.user);
      events.emit('members');
      events.emit('profile', m.user);
      break;
    }
    case 'memberLeft':
      doc.members.delete(m.userId);
      events.emit('members');
      break;
    case 'role': {
      const u = doc.members.get(m.userId);
      if (u) u.role = m.role;
      if (doc.you?.id === m.userId) doc.you.role = m.role;
      events.emit('members');
      break;
    }
    case 'chat':
      doc.messages.push(m.message);
      events.emit('chat', m.message);
      break;
    case 'take':
      doc.takes.set(m.take.id, m.take);
      events.emit('takes');
      break;
    case 'takeRemoved':
      doc.takes.delete(m.id);
      events.emit('takes');
      break;
  }
}

// полная пересинхронизация (после отклонённой операции)
async function resync() {
  if (!projectId) return;
  try {
    const s = await api(`/api/projects/${projectId}`);
    doc.project = s.project;
    doc.items = new Map(s.items.map(i => [i.id, i]));
    doc.takes = new Map(s.takes.map(t => [t.id, t]));
    for (const p of pending) applyOp(p.op, newChanged());
    events.emit('state');
  } catch (e) {
    events.emit('error', e.message);
  }
}

// ---------- публичный API изменений ----------

// Применить и отправить операцию. undoable=false — для служебных изменений (не попадают в историю).
export function op(o, { undoable = true, label = '' } = {}) {
  if (!o || (o.type === 'batch' && !o.ops.length)) return;
  if (!canEdit()) { events.emit('error', 'у вас права только на просмотр'); return; }
  const inv = undoable ? inverse(o) : null;
  const changed = newChanged();
  applyOp(o, changed);
  const cid = ++cidSeq;
  const sent = send({ t: 'op', op: o, cid });
  pending.push({ cid, op: o, sent });
  if (inv) { undoStack.push({ fwd: o, inv, label }); if (undoStack.length > 300) undoStack.shift(); redoStack.length = 0; }
  changed.local = true;
  events.emit('change', changed);
  events.emit('history');
}

export const add = (kind, id, data, opts) => op({ type: 'add', kind, id, data }, opts);
export const update = (id, data, opts) => op({ type: 'update', id, data }, opts);
export const remove = (id, opts) => op({ type: 'remove', id }, opts);
export const batch = (ops, opts) => op({ type: 'batch', ops: ops.filter(Boolean) }, opts);

export function undo() {
  const e = undoStack.pop();
  if (!e) return;
  const fwd = inverse(e.inv); // актуальная «повторялка» с учётом чужих правок
  op(e.inv, { undoable: false });
  if (fwd) redoStack.push({ fwd, inv: e.inv, label: e.label });
  events.emit('history');
}

export function redo() {
  const e = redoStack.pop();
  if (!e) return;
  const inv = inverse(e.fwd);
  op(e.fwd, { undoable: false });
  if (inv) undoStack.push({ fwd: e.fwd, inv, label: e.label });
  events.emit('history');
}

export const history = () => ({ undo: undoStack.length, redo: redoStack.length });

const sendPresence = throttle(p => send({ t: 'presence', ...p }), 70);
let myPresence = {};
export function presence(p) {
  myPresence = { ...myPresence, ...p };
  sendPresence(myPresence);
}

export function chat(text) {
  return send({ t: 'chat', text });
}

export const pendingCount = () => pending.length;
