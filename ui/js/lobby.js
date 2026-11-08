// Лобби: вход/регистрация и список проектов (создать, войти по коду приглашения).
import { h, fill, timeAgo, avatar } from './util.js';
import { icon } from './icons.js';
import { api, session, DEFAULT_SERVER } from './api.js';
import { prompt, toast, menu, confirm } from './kit.js';

const root = () => document.getElementById('lobby');

export function showAuth(onDone) {
  let mode = 'login';
  const err = h('div.err');
  const user = h('input', { type: 'text', placeholder: 'логин', autocomplete: 'username', spellcheck: false });
  const name = h('input', { type: 'text', placeholder: 'как вас видят другие (например, Аня)', spellcheck: false });
  const pass = h('input', { type: 'password', placeholder: '••••••', autocomplete: 'current-password' });
  const server = h('input', { type: 'text', value: session.server, spellcheck: false, placeholder: DEFAULT_SERVER });
  const nameRow = h('div', {}, h('label', {}, 'Имя в проекте'), name);
  const btn = h('button.ui-btn.primary', { type: 'submit' }, 'Войти');
  const seg = h('div.ui-seg', {},
    h('button.on', { type: 'button', onclick: () => setMode('login') }, 'Вход'),
    h('button', { type: 'button', onclick: () => setMode('register') }, 'Регистрация'));
  const setMode = m => {
    mode = m;
    seg.children[0].classList.toggle('on', m === 'login');
    seg.children[1].classList.toggle('on', m === 'register');
    nameRow.style.display = m === 'register' ? '' : 'none';
    btn.textContent = m === 'login' ? 'Войти' : 'Создать аккаунт';
    pass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    err.textContent = '';
  };
  const form = h('form.auth', {
    onsubmit: async e => {
      e.preventDefault();
      err.textContent = '';
      session.server = server.value;
      btn.disabled = true;
      try {
        const body = { username: user.value.trim(), password: pass.value, displayName: name.value.trim() };
        const r = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body });
        session.token = r.token;
        session.user = r.user;
        onDone(r.user);
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        btn.disabled = false;
      }
    },
  },
    h('div.logo-big', {}, h('img', { src: 'icons/jd/logo.svg', alt: '' }), h('div', {}, h('b', {}, 'JitDub'), h('br'), h('span', {}, 'совместная озвучка аниме и фильмов'))),
    seg,
    h('label', {}, 'Логин'), user,
    nameRow,
    h('label', {}, 'Пароль'), pass,
    btn, err,
    h('details', {}, h('summary', {}, 'Сервер'), h('div', { style: { marginTop: '6px' } }, server)));
  setMode('login');
  fill(root(), form);
  setTimeout(() => user.focus(), 50);
}

export async function showProjects({ onOpen }) {
  const grid = h('div.pgrid');
  const wrap = h('div.projects', {},
    h('div.top', {},
      h('h1', {}, 'Проекты'),
      h('span.grow'),
      h('button.ui-btn.secondary', { onclick: join }, icon('link'), 'Войти по коду'),
      h('button.ui-btn.primary', { onclick: create }, icon('add'), 'Новый проект')),
    grid);
  fill(root(), wrap);

  async function create() {
    const name = await prompt('Новый проект', { placeholder: 'Например: Фрирен — 12 серия', ok: 'Создать' });
    if (name == null) return;
    try {
      const { id } = await api('/api/projects', { method: 'POST', body: { name } });
      onOpen(id);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function join() {
    const code = await prompt('Войти в проект', { label: 'Код приглашения от владельца проекта', placeholder: 'ABCD1234', ok: 'Войти' });
    if (!code) return;
    try {
      const { id } = await api('/api/projects/join', { method: 'POST', body: { code } });
      onOpen(id);
    } catch (e) { toast(e.message, 'err'); }
  }

  fill(grid, h('div.empty', { style: { gridColumn: '1/-1' } }, 'Загрузка…'));
  try {
    const { projects } = await api('/api/projects');
    if (!projects.length) {
      fill(grid, h('div.empty', { style: { gridColumn: '1/-1' } },
        h('b', {}, 'Пока нет проектов'),
        h('span', {}, 'Создайте проект и пригласите актёров по коду — или войдите по коду, который вам прислали.'),
        h('div.row', { style: { marginTop: '6px' } },
          h('button.ui-btn.secondary', { onclick: join }, 'Войти по коду'),
          h('button.ui-btn.primary', { onclick: create }, 'Новый проект'))));
      return;
    }
    fill(grid, projects.map(p => {
      const pct = p.cues ? Math.round((p.done / p.cues) * 100) : 0;
      const card = h('div.pcard', {
        onclick: () => onOpen(p.id),
        oncontextmenu: e => {
          e.preventDefault();
          menu(e.clientX, e.clientY, [
            { label: 'Открыть', icon: 'folder', onClick: () => onOpen(p.id) },
            '-',
            p.role === 'owner'
              ? { label: 'Удалить проект…', icon: 'delete', danger: true, onClick: () => del(p) }
              : { label: 'Выйти из проекта', icon: 'exit', danger: true, onClick: () => leave(p) },
          ]);
        },
      },
        h('div.t', {}, icon('film'), h('b', {}, p.name), h('span.grow'), h(`span.badge.${p.role}`, {}, { owner: 'владелец', editor: 'актёр', viewer: 'зритель' }[p.role])),
        h('div.vid', {}, p.video?.name ? p.video.name : h('span', {}, 'видео не выбрано')),
        h('div.bar', {}, h('i', { style: { width: pct + '%' } })),
        h('div.meta', {},
          h('span', {}, p.cues ? `${p.done}/${p.cues} реплик` : 'нет реплик'),
          h('span', {}, `${p.members} уч.`),
          p.online ? h('span.live', {}, `● ${p.online} онлайн`) : null,
          h('span.grow'),
          h('span', {}, timeAgo(p.updatedAt))));
      return card;
    }));
  } catch (e) {
    fill(grid, h('div.empty', { style: { gridColumn: '1/-1' } }, h('b', {}, 'Не удалось загрузить проекты'), h('span', {}, e.message),
      h('button.ui-btn.secondary', { onclick: () => showProjects({ onOpen }) }, icon('refresh'), 'Повторить')));
  }

  async function del(p) {
    if (!(await confirm('Удалить проект?', `«${p.name}» будет удалён вместе со всеми дублями и репликами у всех участников. Это нельзя отменить.`))) return;
    try { await api(`/api/projects/${p.id}`, { method: 'DELETE' }); showProjects({ onOpen }); } catch (e) { toast(e.message, 'err'); }
  }
  async function leave(p) {
    if (!(await confirm('Выйти из проекта?', `Вы потеряете доступ к «${p.name}», пока вас снова не пригласят.`, { ok: 'Выйти' }))) return;
    try { await api(`/api/projects/${p.id}/members/${session.user.id}`, { method: 'DELETE' }); showProjects({ onOpen }); } catch (e) { toast(e.message, 'err'); }
  }
}

export { avatar };
