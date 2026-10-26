// Inicio de sesión y registro (usuarios en MariaDB). Si el servidor no tiene base de
// datos configurada, la app se abre sin login.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let user = null;
let onReady = null;

async function call(path, data) {
  const res = await fetch(path, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error ?? res.statusText), { status: res.status });
  return body;
}

export const currentUser = () => user;

function render(info, mode) {
  const el = $('#auth');
  const signup = mode === 'signup';
  el.innerHTML = `<div class="auth-card">
    <img class="auth-logo" src="/brand-logo.png" alt="Agent Studio" />
    <h1>${signup ? (info.firstUser ? 'Crea la cuenta de administrador' : 'Crea tu cuenta') : 'Bienvenido de nuevo'}</h1>
    <p class="muted">${signup ? (info.firstUser ? 'Es la primera cuenta: tendrá permisos de administrador.' : 'Empieza a crear agentes y automatizaciones.') : 'Inicia sesión para continuar en Agent Studio.'}</p>
    ${info.signup && !info.firstUser ? `<div class="auth-tabs" role="tablist">
      <button type="button" class="${signup ? '' : 'active'}" data-mode="login" role="tab" aria-selected="${!signup}">Iniciar sesión</button>
      <button type="button" class="${signup ? 'active' : ''}" data-mode="signup" role="tab" aria-selected="${signup}">Crear cuenta</button></div>` : ''}
    <form id="auth-form" novalidate>
      ${signup ? '<label>Nombre<input name="name" autocomplete="name" required maxlength="80" /></label>' : ''}
      <label>Email<input name="email" type="email" autocomplete="email" required /></label>
      <label>Contraseña<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}" />
        ${signup ? '<small class="muted">Mínimo 8 caracteres.</small>' : ''}</label>
      ${signup ? '<label>Repite la contraseña<input name="password2" type="password" autocomplete="new-password" required /></label>' : ''}
      <p id="auth-error" class="auth-error" role="alert" hidden></p>
      <button class="primary" type="submit">${signup ? 'Crear cuenta' : 'Entrar'}</button>
    </form>
    ${!info.signup && !signup ? '<p class="muted small">¿No tienes cuenta? Pide acceso al administrador.</p>' : ''}
  </div>`;
  el.hidden = false;
  el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => render(info, b.dataset.mode)));
  const form = $('#auth-form');
  form.querySelector('input').focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const err = $('#auth-error');
    const show = (m) => { err.textContent = m; err.hidden = false; };
    if (signup && d.password !== d.password2) return show('Las contraseñas no coinciden.');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await call(signup ? '/api/auth/register' : '/api/auth/login', signup ? { name: d.name, email: d.email, password: d.password } : { email: d.email, password: d.password });
      user = r.user;
      el.hidden = true;
      el.innerHTML = '';
      paintUser();
      onReady?.();
    } catch (ex) {
      show(ex.message);
      btn.disabled = false;
    }
  };
}

function paintUser() {
  const box = $('#user-menu');
  if (!box) return;
  if (!user) { box.hidden = true; return; }
  box.hidden = false;
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  box.innerHTML = `<button class="user-btn" aria-haspopup="true" aria-expanded="false" title="${esc(user.name)}">${esc(initials)}</button>
    <div class="user-pop" hidden><b>${esc(user.name)}</b><span class="muted small">${esc(user.email)}${user.role === 'admin' ? ' · administrador' : ''}</span><button class="ghost" data-logout>Cerrar sesión</button></div>`;
  const btn = $('.user-btn', box);
  const pop = $('.user-pop', box);
  btn.onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); };
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) pop.hidden = true; });
  $('[data-logout]', box).onclick = async () => { await call('/api/auth/logout', {}); location.reload(); };
  const hello = $('.hello');
  if (hello && !hello.dataset.named) { hello.dataset.named = '1'; hello.innerHTML = `Hola, ${esc(user.name.split(/\s+/)[0])}. ¿Listo para <em>construir?</em>`; }
}

// Llama a ready() cuando hay sesión (o si el login está desactivado)
export async function ensureAuth(ready) {
  onReady = ready;
  const info = await call('/api/auth/info').catch(() => ({ enabled: false }));
  if (!info.enabled) return ready();
  try {
    user = (await call('/api/auth/me')).user;
    paintUser();
    ready();
  } catch {
    render(info, info.firstUser ? 'signup' : 'login');
  }
}

// La sesión caducó a mitad de uso
export async function sessionExpired() {
  if (!$('#auth').hidden) return;
  user = null;
  const info = await call('/api/auth/info').catch(() => ({ enabled: true, signup: true }));
  onReady = () => location.reload();
  render(info, 'login');
}
