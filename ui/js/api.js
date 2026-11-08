// Связь с сервером JitDub (HTTP) и с ядром Tauri (диалоги, запись файлов).
const T = window.__TAURI__;
export const isTauri = !!T?.core;

export const DEFAULT_SERVER = 'https://jitdub.moelibre.cc';

const LS = {
  get(k, d) { try { const v = localStorage.getItem('jitdub.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('jitdub.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('jitdub.' + k); } catch {} },
};
export const prefs = LS;

export const session = {
  get server() { return (LS.get('server', DEFAULT_SERVER) || DEFAULT_SERVER).replace(/\/+$/, ''); },
  set server(v) { LS.set('server', String(v || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER); },
  get token() { return LS.get('token', null); },
  set token(v) { v ? LS.set('token', v) : LS.del('token'); },
  get user() { return LS.get('user', null); },
  set user(v) { v ? LS.set('user', v) : LS.del('user'); },
};

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const isBin = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  let r;
  try {
    r = await fetch(session.server + path, {
      method,
      headers: {
        ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
        ...(body && !isBin ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: isBin ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError('нет связи с JitDub — проверьте интернет', 0);
  }
  if (raw && r.ok) return r;
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401 && session.token && !path.startsWith('/api/auth')) window.dispatchEvent(new CustomEvent('jitdub:unauthorized'));
    throw new ApiError(j?.error || `HTTP ${r.status}`, r.status);
  }
  return j;
}

export function wsUrl(projectId) {
  return `${session.server.replace(/^http/, 'ws')}/ws?project=${encodeURIComponent(projectId)}&token=${encodeURIComponent(session.token || '')}`;
}

// ---------- файлы ----------

// Сохранить байты: в Tauri — системный диалог «Сохранить как», в браузере — скачивание.
export async function saveBytes(name, bytes, filters = [['WAV', 'wav']]) {
  if (isTauri) {
    const path = await T.core.invoke('pick_save_path', { name, filters });
    if (!path) return null;
    await writeFile(path, bytes);
    return path;
  }
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

export async function pickFolder() {
  if (!isTauri) return '';
  return T.core.invoke('pick_folder');
}

export async function writeFile(path, bytes) {
  if (!isTauri) return saveBytes(path.split(/[\\/]/).pop(), bytes);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return T.core.invoke('write_file', u8, { headers: { 'x-path': encodeURIComponent(path) } });
}

export function openExternal(url) {
  if (isTauri) return T.core.invoke('open_external', { url });
  window.open(url, '_blank', 'noopener');
}

export function reveal(path) {
  if (isTauri && path) return T.core.invoke('reveal', { path });
}
