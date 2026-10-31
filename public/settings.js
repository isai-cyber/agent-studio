// Configuración de la empresa: Módulos, Usuarios, Roles, Claves de API y Auditoría.
// Lo que no se puede usar se oculta o desactiva, pero el servidor valida todo.
import { ctx, can, isPlatformAdmin } from './context.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => (d ? new Date(d).toLocaleString(document.documentElement.lang === 'en' ? 'en' : 'es', { dateStyle: 'short', timeStyle: 'short' }) : '—');

let api, post, refreshContext, go;
let tab = 'features';
const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });

const TABS = [
  { k: 'features', label: 'Módulos', show: () => true },
  { k: 'users', label: 'Usuarios', show: () => can('tenant.users.manage') },
  { k: 'roles', label: 'Roles', show: () => can('tenant.roles.manage') || can('tenant.users.manage') },
  { k: 'apikeys', label: 'Claves de API', show: () => can('tenant.apikeys.manage') },
  { k: 'audit', label: 'Auditoría', show: () => can('audit.read') },
  { k: 'billing', label: 'Facturación', show: () => can('tenant.billing.manage') && !ctx?.local },
];

export function initSettings(apiFn, postFn, refresh, show) {
  api = apiFn;
  post = postFn;
  refreshContext = refresh;
  go = show;
}

export async function loadSettingsView(which) {
  const visible = TABS.filter((t) => t.show());
  if (which) tab = which;
  if (!visible.some((t) => t.k === tab)) tab = visible[0].k;
  $('#set-tabs').innerHTML = visible.map((t) => `<button data-set-tab="${t.k}" class="${t.k === tab ? 'active' : ''}">${esc(t.label)}</button>`).join('');
  $$('[data-set-tab]').forEach((b) => (b.onclick = () => loadSettingsView(b.dataset.setTab)));
  $('#set-tenant').textContent = ctx?.tenant ? `${ctx.tenant.name} · plan ${ctx.tenant.plan?.name ?? ''}` : '';
  const body = $('#set-body');
  body.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    await { features: renderFeatures, users: renderUsers, roles: renderRoles, apikeys: renderApiKeys, audit: renderAudit, billing: renderBilling }[tab](body);
  } catch (e) {
    body.innerHTML = `<div class="m-banner warn-banner">✖ ${esc(e.message)}</div>`;
  }
}

// ---------- Módulos ----------

const STATUS = {
  active: { label: 'Activo', cls: 'ok' },
  inactive: { label: 'Inactivo', cls: 'off' },
  needs_config: { label: 'Requiere configuración', cls: 'warn' },
  not_in_plan: { label: 'No incluido en tu plan', cls: 'lock' },
  unavailable: { label: 'No disponible', cls: 'lock' },
};

function configForm(f, editable) {
  const props = Object.entries(f.configSchema?.properties ?? {});
  if (!props.length) return '';
  const field = ([k, s]) => {
    const v = f.config?.[k] ?? s.default;
    const id = `cfg-${f.key}-${k}`;
    const dis = editable ? '' : 'disabled';
    let input;
    if (s.type === 'boolean') input = `<label class="switch"><input type="checkbox" id="${id}" data-cfg="${esc(k)}" data-type="boolean" ${v ? 'checked' : ''} ${dis} /><span></span>${esc(s.title ?? k)}</label>`;
    else if (s.enum) input = `<select id="${id}" data-cfg="${esc(k)}" data-type="${s.type}" ${dis}>${s.enum.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (s.type === 'array') input = `<textarea id="${id}" rows="3" data-cfg="${esc(k)}" data-type="array" placeholder="Uno por línea" ${dis}>${esc((v ?? []).join('\n'))}</textarea>`;
    else input = `<input id="${id}" data-cfg="${esc(k)}" data-type="${s.type}" type="${s.type === 'integer' || s.type === 'number' ? 'number' : 'text'}" value="${esc(v ?? '')}" ${s.minimum !== undefined ? `min="${s.minimum}"` : ''} ${s.maximum !== undefined ? `max="${s.maximum}"` : ''} ${dis} />`;
    return s.type === 'boolean' ? `<div class="cfg-field">${input}</div>` : `<div class="cfg-field"><label for="${id}">${esc(s.title ?? k)}</label>${input}</div>`;
  };
  return `<details class="feat-config"><summary>Configuración</summary>
    <form data-cfg-form="${esc(f.key)}">${props.map(field).join('')}
      ${editable ? '<div class="row"><button class="primary" type="submit">Guardar configuración</button><span class="muted small" data-cfg-msg></span></div>' : ''}
    </form></details>`;
}

function featureCard(f, byKey) {
  const st = STATUS[f.status] ?? STATUS.inactive;
  const manage = can('tenant.features.manage') && (f.scope !== 'platform' || isPlatformAdmin());
  const locked = f.status === 'not_in_plan' || f.status === 'unavailable';
  const toggle = f.toggleable
    ? `<label class="switch" title="${locked ? esc(f.message) : ''}"><input type="checkbox" data-toggle="${esc(f.key)}" ${f.enabled && !locked ? 'checked' : ''} ${manage && !locked ? '' : 'disabled'} /><span></span></label>`
    : '<span class="pill-sm" title="Base de seguridad: siempre activo">Siempre activo</span>';
  const deps = f.dependsOn.length
    ? `<div class="feat-line"><span class="muted small">Depende de:</span> ${f.dependsOn.map((d) => `<span class="tag ${byKey[d]?.usable ? 'tag-ok' : 'tag-warn'}">${esc(byKey[d]?.name ?? d)}${byKey[d]?.usable ? ' ✓' : ''}</span>`).join(' ')}</div>` : '';
  const missing = f.enabled && f.missingConnections.length
    ? `<div class="feat-line"><span class="muted small">Falta conectar:</span> ${f.missingConnections.map((g) => g.map((app) => `<button class="link-btn" data-connect="${esc(app)}">${esc(app)}</button>`).join(' o ')).join(', ')}</div>`
    : f.requiredConnections.length ? `<div class="feat-line"><span class="muted small">Necesita:</span> ${f.requiredConnections.map((g) => esc([].concat(g).join(' o '))).join(', ')}</div>` : '';
  const upgrade = locked && f.status === 'not_in_plan'
    ? `<div class="feat-line lock-line">🔒 <span>${esc(f.message)}</span> <button class="ghost small-btn" data-upgrade="${esc(f.key)}">Mejorar plan</button></div>` : '';
  return `<article class="card feat-card ${locked ? 'locked' : ''}" data-feature="${esc(f.key)}">
    <div class="feat-head"><div><b>${esc(f.name)}</b> <span class="feat-status ${st.cls}">${locked ? '🔒 ' : ''}${esc(st.label)}</span></div>${toggle}</div>
    <p class="muted small">${esc(f.description)}</p>
    ${f.status === 'needs_config' ? `<div class="feat-line warn-text">${esc(f.message)}</div>` : ''}
    ${deps}${missing}${upgrade}
    ${f.notes ? `<p class="muted small">ℹ ${esc(f.notes)}</p>` : ''}
    ${f.inPlan && f.status !== 'unavailable' ? configForm(f, manage) : ''}
  </article>`;
}

async function renderFeatures(body) {
  const { features, groups } = await api('/api/tenant/features');
  const byKey = Object.fromEntries(features.map((f) => [f.key, f]));
  body.innerHTML = `${ctx?.local ? '<div class="m-banner warn-banner">Sin MariaDB los módulos se muestran en solo lectura. Define DB_HOST en .env para gestionarlos por empresa.</div>' : ''}
    <p class="muted">Activa las funciones de negocio que use tu empresa. Desactivar un módulo no borra sus datos: al reactivarlo todo vuelve como estaba.</p>
    ${Object.entries(groups).map(([g, label]) => `<h3>${esc(label)}</h3><div class="feat-grid">${features.filter((f) => f.group === g).map((f) => featureCard(f, byKey)).join('')}</div>`).join('')}`;

  const names = (keys) => keys.map((k) => byKey[k]?.name ?? k).join(', ');
  $$('[data-toggle]', body).forEach((el) => (el.onchange = async () => {
    const key = el.dataset.toggle;
    const enabled = el.checked;
    const send = (cascade) => api(`/api/tenant/features/${key}`, json('PUT', { enabled, cascade }));
    try {
      await send(false);
    } catch (e) {
      const d = e.body ?? {};
      let ok = false;
      if (d.code === 'dependencies') ok = confirm(`Para activar ${byKey[key].name} también hay que activar: ${names(d.requires)}.\n\n¿Activarlos juntos?`);
      else if (d.code === 'dependents') ok = confirm(`Estos módulos dependen de ${byKey[key].name} y también se desactivarán: ${names(d.dependents)}.\n\nSus datos no se borran. ¿Continuar?`);
      else alert(e.message);
      if (ok) { try { await send(true); } catch (e2) { alert(e2.message); } }
    }
    await refreshContext();
    renderFeatures(body);
  }));
  $$('[data-cfg-form]', body).forEach((form) => (form.onsubmit = async (e) => {
    e.preventDefault();
    const key = form.dataset.cfgForm;
    const config = {};
    for (const el of $$('[data-cfg]', form)) {
      const t = el.dataset.type;
      const v = t === 'boolean' ? el.checked : t === 'array' ? el.value.split('\n').map((x) => x.trim()).filter(Boolean) : el.value;
      if (v === '' && t !== 'string') continue;
      config[el.dataset.cfg] = (t === 'integer' || t === 'number') && v !== '' ? Number(v) : v;
    }
    const msg = $('[data-cfg-msg]', form);
    try {
      await api(`/api/tenant/features/${key}/config`, json('PUT', { config }));
      msg.textContent = '✔ Guardado';
    } catch (err) { msg.textContent = `✖ ${err.message}`; }
  }));
  $$('[data-connect]', body).forEach((b) => (b.onclick = () => document.dispatchEvent(new CustomEvent('as:open-app', { detail: b.dataset.connect }))));
  $$('[data-upgrade]', body).forEach((b) => (b.onclick = () => {
    if (isPlatformAdmin()) go('platform');
    else alert('Este módulo no está incluido en tu plan. Pide al administrador de la plataforma que mejore el plan de tu empresa.');
  }));
}

// ---------- Usuarios ----------

async function renderUsers(body) {
  const d = await api('/api/tenant/users');
  const me = ctx?.user?.id;
  const roleOpts = (sel) => d.roles.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const active = d.members.filter((m) => m.status === 'active').length;
  body.innerHTML = `
    <div class="card pad">
      <h3>Invitar a una persona</h3>
      <form id="inv-form" class="row" style="margin:0">
        <input id="inv-email" type="email" placeholder="email@empresa.com" required />
        <select id="inv-role" class="sel-input">${roleOpts(d.roles.find((r) => r.systemKey === 'operator')?.id)}</select>
        <button class="primary" type="submit">Invitar</button>
      </form>
      <p class="muted small">${d.mail ? 'Le enviaremos un correo con el enlace de invitación.' : 'No hay correo configurado: al invitar verás un enlace para compartirlo tú.'} ${d.maxUsers ? `Tu plan permite ${d.maxUsers} usuarios (${active} activos).` : ''}</p>
      <div id="inv-result"></div>
    </div>
    <h3>Usuarios</h3>
    <div class="tbl wide"><table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th></th></tr></thead><tbody>
      ${d.members.map((m) => `<tr data-user="${m.userId}">
        <td>${esc(m.name)}${m.userId === me ? ' <span class="pill-sm">tú</span>' : ''}</td><td>${esc(m.email)}</td>
        <td><select class="sel-input" data-role-of="${m.userId}">${roleOpts(m.roleId)}</select></td>
        <td><span class="feat-status ${m.status === 'active' ? 'ok' : 'off'}">${m.status === 'active' ? 'Activo' : 'Desactivado'}</span></td>
        <td>${fmtDate(m.lastLoginAt)}</td>
        <td class="actions">${m.userId === me ? '' : `<button class="ghost" data-status-of="${m.userId}" data-next="${m.status === 'active' ? 'disabled' : 'active'}">${m.status === 'active' ? 'Desactivar' : 'Activar'}</button><button class="danger" data-remove="${m.userId}">Quitar</button>`}</td>
      </tr>`).join('')}
    </tbody></table></div>
    ${d.invitations.length ? `<h3>Invitaciones pendientes</h3><div class="tbl wide"><table><thead><tr><th>Email</th><th>Rol</th><th>Caduca</th><th></th></tr></thead><tbody>
      ${d.invitations.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.roleName)}</td><td>${fmtDate(i.expiresAt)}</td><td class="actions"><button class="ghost" data-revoke-inv="${i.id}">Anular</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}`;

  $('#inv-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await post('/api/tenant/invitations', { email: $('#inv-email').value, roleId: Number($('#inv-role').value) });
      if (r.link) {
        await renderUsers(body);
        $('#inv-result').innerHTML = `<div class="key-once"><b>Comparte este enlace con ${esc(r.invitation.email)}</b> (caduca en 7 días):<div class="copy-row"><code id="inv-link">${esc(r.link)}</code><button id="copy-inv">Copiar</button></div></div>`;
        $('#copy-inv').onclick = () => navigator.clipboard.writeText(r.link);
      } else {
        await renderUsers(body);
        $('#inv-result').innerHTML = `<p class="muted">✔ Invitación enviada a ${esc(r.invitation.email)}.</p>`;
      }
    } catch (err) { $('#inv-result').innerHTML = `<p class="auth-error">${esc(err.message)}</p>`; }
  };
  const act = async (fn) => { try { await fn(); } catch (err) { alert(err.message); } renderUsers(body); };
  $$('[data-role-of]', body).forEach((s) => (s.onchange = () => act(() => api(`/api/tenant/users/${s.dataset.roleOf}/role`, json('PUT', { roleId: Number(s.value) })))));
  $$('[data-status-of]', body).forEach((b) => (b.onclick = () => act(() => api(`/api/tenant/users/${b.dataset.statusOf}/status`, json('PUT', { status: b.dataset.next })))));
  $$('[data-remove]', body).forEach((b) => (b.onclick = () => confirm('¿Quitar a esta persona de la empresa? Podrás invitarla de nuevo.') && act(() => api(`/api/tenant/users/${b.dataset.remove}`, { method: 'DELETE' }))));
  $$('[data-revoke-inv]', body).forEach((b) => (b.onclick = () => act(() => api(`/api/tenant/invitations/${b.dataset.revokeInv}`, { method: 'DELETE' }))));
}

// ---------- Roles ----------

function matrix(groups, selected, editable) {
  const mine = new Set(ctx?.permissions ?? []);
  return `<div class="perm-matrix">${groups.map((g) => `<fieldset><legend><label><input type="checkbox" data-group-all ${editable ? '' : 'disabled'} /> ${esc(g.group)}</label></legend>
    ${g.permissions.map((p) => `<label class="perm" title="${esc(p.key)}"><input type="checkbox" value="${esc(p.key)}" ${selected.has(p.key) ? 'checked' : ''} ${editable && (mine.has(p.key) || ctx?.local) ? '' : 'disabled'} /> ${esc(p.label)} <code>${esc(p.key)}</code></label>`).join('')}
  </fieldset>`).join('')}</div>`;
}

function bindMatrix(root) {
  $$('fieldset', root).forEach((fs) => {
    const all = $('[data-group-all]', fs);
    const boxes = $$('.perm input', fs);
    all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
    all.onchange = () => boxes.forEach((b) => { if (!b.disabled) b.checked = all.checked; });
  });
}

async function renderRoles(body, editing = null) {
  const [roles, groups] = await Promise.all([api('/api/tenant/roles'), api('/api/tenant/permissions')]);
  const manage = can('tenant.roles.manage');
  body.innerHTML = `
    <p class="muted">Los roles del sistema son plantillas de solo lectura. Clónalos para crear roles propios. Solo puedes dar permisos que tú tengas.</p>
    <div class="grid roles-grid">${roles.map((r) => `<article class="card role-card">
      <div class="feat-head"><b>${esc(r.name)}</b>${r.isSystem ? '<span class="pill-sm">Sistema</span>' : ''}</div>
      <p class="muted small">${esc(r.description ?? '')}</p>
      <p class="muted small">${r.permissions.length} permisos</p>
      <div class="row" style="margin:0">
        <button class="ghost" data-view-role="${r.id}">${r.isSystem || !manage ? 'Ver' : 'Editar'}</button>
        ${manage ? `<button class="ghost" data-clone-role="${r.id}">Clonar</button>` : ''}
        ${manage && !r.isSystem ? `<button class="danger" data-del-role="${r.id}">Eliminar</button>` : ''}
      </div></article>`).join('')}
      ${manage ? '<button class="card role-card new-role" data-new-role>+ Nuevo rol</button>' : ''}
    </div>
    <div id="role-editor"></div>`;

  const openEditor = (role, mode) => {
    const editable = manage && (mode === 'new' || mode === 'clone' || !role?.isSystem);
    const sel = new Set(role?.permissions ?? []);
    const el = $('#role-editor');
    el.innerHTML = `<div class="card pad role-editor">
      <h3>${mode === 'new' ? 'Nuevo rol' : mode === 'clone' ? `Clonar «${esc(role.name)}»` : esc(role.name)}</h3>
      <div class="row" style="margin:0"><input id="role-name" placeholder="Nombre del rol" value="${mode === 'clone' ? esc(`${role.name} (copia)`) : esc(mode === 'new' ? '' : role.name)}" ${editable ? '' : 'disabled'} />
      <input id="role-desc" placeholder="Descripción (opcional)" value="${esc(mode === 'new' ? '' : role.description ?? '')}" ${editable ? '' : 'disabled'} /></div>
      ${matrix(groups, sel, editable)}
      ${editable ? '<div class="row"><button class="primary" id="role-save">Guardar rol</button><button class="ghost" id="role-cancel">Cancelar</button><span class="muted small" id="role-msg"></span></div>' : '<button class="ghost" id="role-cancel">Cerrar</button>'}
    </div>`;
    bindMatrix(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#role-cancel').onclick = () => (el.innerHTML = '');
    const save = $('#role-save');
    if (save) save.onclick = async () => {
      const permissions = $$('.perm input:checked', el).map((b) => b.value);
      const data = { name: $('#role-name').value, description: $('#role-desc').value, permissions };
      try {
        if (mode === 'edit') await api(`/api/tenant/roles/${role.id}`, json('PUT', data));
        else await post('/api/tenant/roles', data);
        renderRoles(body);
      } catch (err) { $('#role-msg').textContent = `✖ ${err.message}`; }
    };
  };
  const byId = (id) => roles.find((r) => r.id === Number(id));
  $$('[data-view-role]', body).forEach((b) => (b.onclick = () => openEditor(byId(b.dataset.viewRole), 'edit')));
  $$('[data-clone-role]', body).forEach((b) => (b.onclick = () => openEditor(byId(b.dataset.cloneRole), 'clone')));
  $('[data-new-role]', body)?.addEventListener('click', () => openEditor(null, 'new'));
  $$('[data-del-role]', body).forEach((b) => (b.onclick = async () => {
    if (!confirm('¿Eliminar este rol?')) return;
    try { await api(`/api/tenant/roles/${b.dataset.delRole}`, { method: 'DELETE' }); } catch (err) { alert(err.message); }
    renderRoles(body);
  }));
  if (editing) openEditor(editing, 'edit');
}

// ---------- Claves de API ----------

async function renderApiKeys(body) {
  const [keys, groups] = await Promise.all([api('/api/tenant/apikeys'), api('/api/tenant/permissions')]);
  body.innerHTML = `
    <div class="card pad">
      <h3>Nueva clave de API</h3>
      <p class="muted small">Para <code>/v1</code>, el endpoint compatible con OpenAI y <code>/mcp</code>. La clave solo podrá hacer lo que marques (y nunca más de lo que puedes hacer tú). La verás una sola vez.</p>
      <input id="key-name" placeholder="Nombre (p. ej. «n8n producción»)" />
      <details open><summary>Permisos (scopes)</summary>
        <div class="row" style="margin:6px 0"><button class="ghost" id="key-preset-read">Solo lectura</button><button class="ghost" id="key-preset-chat">Chatear con agentes</button><button class="ghost" id="key-preset-all">Todos mis permisos</button></div>
        ${matrix(groups, new Set(['agents.read']), true)}
      </details>
      <div class="row"><button class="primary" id="key-create">Crear clave</button><span class="muted small" id="key-msg"></span></div>
      <div id="key-once"></div>
    </div>
    <h3>Claves</h3>
    ${keys.length ? `<div class="tbl wide"><table><thead><tr><th>Nombre</th><th>Clave</th><th>Permisos</th><th>Creada</th><th>Último uso</th><th>Estado</th><th></th></tr></thead><tbody>
      ${keys.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td title="${esc(k.scopes.join('\n'))}">${k.scopes.includes('*') ? 'Todos' : k.scopes.length}</td>
        <td>${fmtDate(k.createdAt)}</td><td>${fmtDate(k.lastUsedAt)}</td>
        <td><span class="feat-status ${k.revokedAt ? 'off' : 'ok'}">${k.revokedAt ? `Revocada ${fmtDate(k.revokedAt)}` : 'Activa'}</span></td>
        <td class="actions">${k.revokedAt ? '' : `<button class="danger" data-revoke-key="${k.id}">Revocar</button>`}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Aún no hay claves.</p>'}`;
  bindMatrix(body);
  const setScopes = (pred) => $$('.perm input', body).forEach((b) => { if (!b.disabled) b.checked = pred(b.value); });
  $('#key-preset-read').onclick = () => setScopes((p) => p.endsWith('.read'));
  $('#key-preset-chat').onclick = () => setScopes((p) => p === 'agents.read');
  $('#key-preset-all').onclick = () => setScopes(() => true);
  $('#key-create').onclick = async () => {
    const scopes = $$('.perm input:checked', body).map((b) => b.value);
    try {
      const r = await post('/api/tenant/apikeys', { name: $('#key-name').value, scopes });
      await renderApiKeys(body);
      $('#key-once').innerHTML = `<div class="key-once"><b>Copia la clave ahora: no se volverá a mostrar.</b><div class="copy-row"><code>${esc(r.key)}</code><button id="copy-key-once">Copiar</button></div>
        <p class="muted small">Envíala como <code>Authorization: Bearer &lt;clave&gt;</code> o <code>X-Api-Key</code>.</p></div>`;
      $('#copy-key-once').onclick = () => navigator.clipboard.writeText(r.key);
    } catch (err) { $('#key-msg').textContent = `✖ ${err.message}`; }
  };
  $$('[data-revoke-key]', body).forEach((b) => (b.onclick = async () => {
    if (!confirm('¿Revocar la clave? Las apps que la usen dejarán de funcionar al momento.')) return;
    try { await api(`/api/tenant/apikeys/${b.dataset.revokeKey}`, { method: 'DELETE' }); } catch (err) { alert(err.message); }
    renderApiKeys(body);
  }));
}

// ---------- Auditoría ----------

const ACTOR = { user: 'Usuario', api_key: 'Clave de API', system: 'Sistema', superadmin: 'Superadmin' };
const short = (v) => { if (v === null || v === undefined) return ''; const s = JSON.stringify(v); return s.length > 120 ? `${s.slice(0, 117)}…` : s; };

async function renderAudit(body) {
  body.innerHTML = `
    <p class="muted">Registro de solo lectura de todos los cambios de módulos, roles, usuarios, conexiones y claves de API, y de cada inicio de sesión. Nadie puede editarlo ni borrarlo.</p>
    <form id="aud-form" class="aud-filters">
      <input id="aud-actor" placeholder="Actor (email o: user, api_key, system, superadmin)" />
      <input id="aud-action" placeholder="Acción (p. ej. feature, member, auth.login)" />
      <label class="muted small">Desde <input id="aud-from" type="date" /></label>
      <label class="muted small">Hasta <input id="aud-to" type="date" /></label>
      <button class="primary" type="submit">Filtrar</button>
      <a class="ghost-link" id="aud-csv" href="#">Exportar CSV</a>
    </form>
    <div class="tbl wide aud-tbl"><table><thead><tr><th>Fecha</th><th>Actor</th><th>Acción</th><th>Objetivo</th><th>Antes</th><th>Después</th><th>IP</th></tr></thead><tbody id="aud-rows"></tbody></table></div>
    <div class="row"><span class="muted small" id="aud-count"></span><button class="ghost" id="aud-more" hidden>Cargar más</button></div>`;
  let offset = 0;
  const params = () => new URLSearchParams(Object.entries({ actor: $('#aud-actor').value, action: $('#aud-action').value, from: $('#aud-from').value, to: $('#aud-to').value }).filter(([, v]) => v));
  const load = async (reset) => {
    if (reset) { offset = 0; $('#aud-rows').innerHTML = ''; }
    const p = params();
    p.set('limit', '100');
    p.set('offset', String(offset));
    const { rows, total } = await api(`/api/tenant/audit?${p}`);
    $('#aud-rows').insertAdjacentHTML('beforeend', rows.map((r) => `<tr><td>${fmtDate(r.createdAt)}</td><td>${esc(r.actorEmail ?? (r.actorUserId ? `#${r.actorUserId}` : ''))} <span class="muted small">${esc(ACTOR[r.actorType] ?? r.actorType)}</span></td>
      <td><code>${esc(r.action)}</code></td><td>${esc(r.target ?? '')}</td><td class="mono" title="${esc(JSON.stringify(r.before))}">${esc(short(r.before))}</td><td class="mono" title="${esc(JSON.stringify(r.after))}">${esc(short(r.after))}</td><td>${esc(r.ip ?? '')}</td></tr>`).join(''));
    offset += rows.length;
    $('#aud-count').textContent = `${offset} de ${total} registros`;
    $('#aud-more').hidden = offset >= total;
    $('#aud-csv').href = `/api/tenant/audit.csv?${params()}`;
  };
  $('#aud-form').onsubmit = (e) => { e.preventDefault(); load(true); };
  $('#aud-more').onclick = () => load(false);
  await load(true);
}

// ---------- Facturación (Propietario) ----------

const CHARGE = { pending: ['Pendiente de pago', 'warn'], paid: ['Pagado', 'ok'], cancelled: ['Anulado', 'off'] };

async function renderBilling(body) {
  const b = await api('/api/tenant/billing');
  const lim = (v) => (v === null || v === undefined ? 'Sin límite' : Number(v).toLocaleString());
  body.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="k-label">Plan</div><div class="k-value">${esc(b.plan.name)}</div></div>
      <div class="kpi"><div class="k-label">Conversaciones este mes</div><div class="k-value">${Number(b.usage.conversations).toLocaleString()}</div><div class="k-sub">Límite: ${lim(b.plan.maxConversationsMonth)}</div></div>
      <div class="kpi"><div class="k-label">Agentes</div><div class="k-value">${b.agents}</div><div class="k-sub">Límite: ${lim(b.plan.maxAgents)}</div></div>
      <div class="kpi"><div class="k-label">Usuarios</div><div class="k-value">${lim(b.plan.maxUsers)}</div><div class="k-sub">permitidos</div></div>
    </div>
    <h3>Cobros</h3>
    ${b.charges.length ? `<div class="tbl wide"><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Importe</th><th>Estado</th><th></th></tr></thead><tbody>
      ${b.charges.map((c) => `<tr><td>${fmtDate(c.createdAt)}</td><td>${esc(c.description)}</td><td>${c.amount.toFixed(2)} ${esc(c.currency)}</td>
        <td><span class="feat-status ${CHARGE[c.status][1]}">${CHARGE[c.status][0]}</span></td>
        <td class="actions">${c.status === 'pending' && c.url ? `<a class="primary-link" href="${esc(c.url)}" target="_blank" rel="noopener">Pagar ↗</a>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No tienes cobros pendientes.</p>'}`;
}
