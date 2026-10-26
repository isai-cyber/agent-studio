// Superadmin de la plataforma: empresas (crear, suspender, entrar como soporte,
// consumo del mes) y planes (límites, precio por conversación y módulos incluidos).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });
const num = (v) => (v === null || v === undefined ? '∞' : Number(v).toLocaleString('es'));
const STATUS = { active: ['Activa', 'ok'], suspended: ['Suspendida', 'warn'], deleted: ['Eliminada', 'off'] };

let api, post, afterSupport;
let tab = 'tenants';

export function initPlatform(apiFn, postFn, onSupport) {
  api = apiFn;
  post = postFn;
  afterSupport = onSupport;
}

export async function loadPlatformView(which) {
  if (which) tab = which;
  $('#plat-tabs').innerHTML = [['tenants', 'Empresas'], ['plans', 'Planes']].map(([k, l]) => `<button data-plat-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('');
  $$('[data-plat-tab]').forEach((b) => (b.onclick = () => loadPlatformView(b.dataset.platTab)));
  const body = $('#plat-body');
  body.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    await (tab === 'tenants' ? renderTenants(body) : renderPlans(body));
  } catch (e) {
    body.innerHTML = `<div class="m-banner warn-banner">✖ ${esc(e.message)}</div>`;
  }
}

async function renderTenants(body) {
  const [tenants, { plans }] = await Promise.all([api('/api/platform/tenants'), api('/api/platform/plans')]);
  const planOpts = (sel) => plans.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const totals = tenants.reduce((a, t) => ({ conv: a.conv + t.usage.conversations, cost: a.cost + t.usage.costUsd, charge: a.charge + t.estimatedCharge }), { conv: 0, cost: 0, charge: 0 });
  body.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="k-label">Empresas</div><div class="k-value">${tenants.length}</div></div>
      <div class="kpi"><div class="k-label">Conversaciones este mes</div><div class="k-value">${num(totals.conv)}</div></div>
      <div class="kpi"><div class="k-label">Coste de IA este mes</div><div class="k-value">$${totals.cost.toFixed(2)}</div></div>
      <div class="kpi"><div class="k-label">Cobro estimado</div><div class="k-value">$${totals.charge.toFixed(2)}</div><div class="k-sub">conversaciones × precio del plan</div></div>
    </div>
    <details class="card pad"><summary><b>+ Nueva empresa</b></summary>
      <form id="t-form" class="t-form">
        <input name="name" placeholder="Nombre de la empresa" required />
        <input name="slug" placeholder="Identificador (opcional, p. ej. mi-tienda)" pattern="[a-z0-9][a-z0-9-]{1,59}" />
        <select name="planId" class="sel-input">${planOpts(plans[0]?.id)}</select>
        <input name="country" placeholder="País (MX, ES…)" maxlength="2" />
        <input name="ownerEmail" type="email" placeholder="Email del propietario (se le invita)" />
        <button class="primary" type="submit">Crear empresa</button>
      </form>
      <div id="t-result"></div>
    </details>
    <div class="tbl wide"><table><thead><tr><th>Empresa</th><th>Plan</th><th>Estado</th><th>Usuarios</th><th>Agentes</th><th>Conversaciones (mes)</th><th>Coste IA</th><th>Cobro estimado</th><th></th></tr></thead><tbody>
      ${tenants.map((t) => `<tr>
        <td><b>${esc(t.name)}</b><br><span class="muted small">${esc(t.slug)}${t.country ? ` · ${esc(t.country)}` : ''}</span></td>
        <td><select class="sel-input" data-plan-of="${t.id}">${planOpts(t.planId)}</select></td>
        <td><span class="feat-status ${STATUS[t.status][1]}">${STATUS[t.status][0]}</span></td>
        <td>${t.members}</td><td>${t.agents}</td><td>${num(t.usage.conversations)}</td><td>$${t.usage.costUsd.toFixed(2)}</td><td>$${t.estimatedCharge.toFixed(2)}</td>
        <td class="actions">
          <button class="ghost" data-support="${t.id}">Entrar como soporte</button>
          ${t.id === 1 ? '' : t.status === 'active' ? `<button class="danger" data-status="${t.id}" data-next="suspended">Suspender</button>` : `<button class="ghost" data-status="${t.id}" data-next="active">Reactivar</button>`}
        </td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small">Entrar como soporte te da permisos de Admin en esa empresa (sin facturación ni eliminarla) y queda registrado en su auditoría.</p>`;

  $('#t-form').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try {
      const r = await post('/api/platform/tenants', { ...d, planId: Number(d.planId) });
      await renderTenants(body);
      const inv = r.invitation;
      $('#t-result').innerHTML = `<div class="key-once"><div><b>✔ Empresa «${esc(r.tenant.name)}» creada.</b> Sus webhooks: <code>/hooks/${esc(r.tenant.slug)}/…</code></div>
        ${inv ? (inv.link ? `<div>Comparte con ${esc(inv.email)} el enlace para ser Propietario:</div><div class="copy-row"><code>${esc(inv.link)}</code><button id="copy-t-inv">Copiar</button></div>` : `<div>Invitación enviada a ${esc(inv.email)}.</div>`) : ''}</div>`;
      $('#copy-t-inv')?.addEventListener('click', () => navigator.clipboard.writeText(inv.link));
      $('details', body).open = true;
    } catch (err) { $('#t-result').innerHTML = `<p class="auth-error">${esc(err.message)}</p>`; }
  };
  const act = async (fn) => { try { await fn(); } catch (err) { alert(err.message); } renderTenants(body); };
  $$('[data-plan-of]', body).forEach((s) => (s.onchange = () => act(() => api(`/api/platform/tenants/${s.dataset.planOf}`, json('PUT', { planId: Number(s.value) })))));
  $$('[data-status]', body).forEach((b) => (b.onclick = () => {
    if (b.dataset.next === 'suspended' && !confirm('¿Suspender la empresa? Sus usuarios, claves de API, webhooks y automatizaciones dejarán de funcionar hasta reactivarla. No se borra nada.')) return;
    act(() => api(`/api/platform/tenants/${b.dataset.status}`, json('PUT', { status: b.dataset.next })));
  }));
  $$('[data-support]', body).forEach((b) => (b.onclick = async () => {
    if (!confirm('Vas a entrar en esta empresa como soporte. Quedará registrado en su auditoría. ¿Continuar?')) return;
    try { await post(`/api/platform/tenants/${b.dataset.support}/support`); afterSupport(); } catch (err) { alert(err.message); }
  }));
}

async function renderPlans(body) {
  const { plans, features, groups } = await api('/api/platform/plans');
  const limit = (p, k, label) => `<label class="cfg-field"><span>${label}</span><input type="number" min="0" data-k="${k}" value="${p?.[k] ?? ''}" placeholder="Sin límite" /></label>`;
  const card = (p) => `<article class="card pad plan-card" data-plan="${p?.id ?? ''}">
    <input class="plan-name" data-k="name" value="${esc(p?.name ?? '')}" placeholder="Nombre del plan" />
    <div class="plan-limits">
      ${limit(p, 'maxConversationsMonth', 'Conversaciones al mes')}
      ${limit(p, 'maxUsers', 'Usuarios')}
      ${limit(p, 'maxAgents', 'Agentes')}
      ${limit(p, 'maxCampaignMessages', 'Mensajes de campaña')}
      <label class="cfg-field"><span>Precio por conversación (USD)</span><input type="number" min="0" step="0.0001" data-k="pricePerConversation" value="${p?.pricePerConversation ?? 0}" /></label>
    </div>
    <div class="plan-feats">${Object.entries(groups).map(([g, label]) => `<fieldset><legend>${esc(label)}</legend>
      ${features.filter((f) => f.group === g).map((f) => `<label class="perm"><input type="checkbox" value="${f.key}" ${!f.toggleable || p?.features.includes(f.key) ? 'checked' : ''} ${f.toggleable ? '' : 'disabled'} /> ${esc(f.name)}${f.scope === 'platform' ? ' <span class="pill-sm">plataforma</span>' : ''}</label>`).join('')}
    </fieldset>`).join('')}</div>
    <div class="row"><button class="primary" data-save-plan>Guardar plan</button><span class="muted small" data-plan-msg></span></div>
  </article>`;
  body.innerHTML = `<p class="muted">Los límites vacíos son ilimitados. Quitar un módulo de un plan lo bloquea en las empresas con ese plan, pero no borra sus datos.</p>
    <div class="plans">${plans.map(card).join('')}</div>
    <details class="card pad"><summary><b>+ Nuevo plan</b></summary>${card(null)}</details>`;
  $$('[data-save-plan]', body).forEach((b) => (b.onclick = async () => {
    const el = b.closest('[data-plan]');
    const data = Object.fromEntries($$('[data-k]', el).map((i) => [i.dataset.k, i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value]));
    data.features = $$('.plan-feats input:checked', el).map((i) => i.value);
    const msg = $('[data-plan-msg]', el);
    try {
      if (el.dataset.plan) await api(`/api/platform/plans/${el.dataset.plan}`, json('PUT', data));
      else await post('/api/platform/plans', data);
      msg.textContent = '✔ Guardado';
      if (!el.dataset.plan) renderPlans(body);
    } catch (err) { msg.textContent = `✖ ${err.message}`; }
  }));
}
