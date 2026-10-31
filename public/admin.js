// Superadmin de la plataforma: empresas (crear, suspender, entrar como soporte,
// consumo del mes, idioma, forma de cobro y cobros), planes (límites, precio por
// conversación y módulos incluidos) y ajustes (las claves de IA con las que das
// el servicio y las cuentas de Stripe y Mercado Pago con las que cobras), plantillas
// de las webs de tus clientes y el marketplace (tu comisión por cada venta).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });
const num = (v) => (v === null || v === undefined ? '∞' : Number(v).toLocaleString('es'));
const STATUS = { active: ['Activa', 'ok'], suspended: ['Suspendida', 'warn'], deleted: ['Eliminada', 'off'] };
const LANG_OPTS = (sel) => [['es', 'Español'], ['en', 'Inglés']].map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');
const BILLING_OPTS = (sel) => [['', 'Sin cobro'], ['stripe', 'Stripe'], ['mercadopago', 'Mercado Pago']].map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');
const CHARGE_STATUS = { pending: ['Pendiente', 'warn'], paid: ['Pagado', 'ok'], cancelled: ['Anulado', 'off'] };
const fmtDate = (d) => (d ? new Date(d).toLocaleString(document.documentElement.lang === 'en' ? 'en' : 'es', { dateStyle: 'short', timeStyle: 'short' }) : '—');

let api, post, afterSupport;
let tab = 'tenants';

export function initPlatform(apiFn, postFn, onSupport) {
  api = apiFn;
  post = postFn;
  afterSupport = onSupport;
}

export async function loadPlatformView(which) {
  if (which) tab = which;
  $('#plat-tabs').innerHTML = [['tenants', 'Empresas'], ['plans', 'Planes'], ['templates', 'Plantillas web'], ['settings', 'Ajustes']].map(([k, l]) => `<button data-plat-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('');
  $$('[data-plat-tab]').forEach((b) => (b.onclick = () => loadPlatformView(b.dataset.platTab)));
  const body = $('#plat-body');
  body.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    await (tab === 'tenants' ? renderTenants(body) : tab === 'plans' ? renderPlans(body) : tab === 'templates' ? renderTemplates(body) : renderSettings(body));
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
        <select name="language" class="sel-input" aria-label="Idioma">${LANG_OPTS('es')}</select>
        <select name="billingProvider" class="sel-input" aria-label="Forma de cobro">${BILLING_OPTS('')}</select>
        <button class="primary" type="submit">Crear empresa</button>
      </form>
      <div id="t-result"></div>
    </details>
    <div class="tbl wide"><table><thead><tr><th>Empresa</th><th>Plan</th><th>Idioma</th><th>Cobro</th><th>Estado</th><th>Usuarios</th><th>Agentes</th><th>Conversaciones (mes)</th><th>Coste IA</th><th>Cobro estimado</th><th></th></tr></thead><tbody>
      ${tenants.map((t) => `<tr>
        <td><b>${esc(t.name)}</b><br><span class="muted small">${esc(t.slug)}${t.country ? ` · ${esc(t.country)}` : ''}</span></td>
        <td><select class="sel-input" data-plan-of="${t.id}">${planOpts(t.planId)}</select></td>
        <td><select class="sel-input" data-lang-of="${t.id}">${LANG_OPTS(t.language)}</select></td>
        <td><select class="sel-input" data-billing-of="${t.id}">${BILLING_OPTS(t.billingProvider ?? '')}</select></td>
        <td><span class="feat-status ${STATUS[t.status][1]}">${STATUS[t.status][0]}</span></td>
        <td>${t.members}</td><td>${t.agents}</td><td>${num(t.usage.conversations)}</td><td>$${t.usage.costUsd.toFixed(2)}</td><td>$${t.estimatedCharge.toFixed(2)}</td>
        <td class="actions">
          <button class="ghost" data-charges="${t.id}" data-amount="${t.estimatedCharge}" data-name="${esc(t.name)}">Cobros</button>
          <button class="ghost" data-support="${t.id}">Entrar como soporte</button>
          ${t.id === 1 ? '' : t.status === 'active' ? `<button class="danger" data-status="${t.id}" data-next="suspended">Suspender</button>` : `<button class="ghost" data-status="${t.id}" data-next="active">Reactivar</button>`}
        </td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small">Entrar como soporte te da permisos de Admin en esa empresa (sin facturación ni eliminarla) y queda registrado en su auditoría.</p>
    <div id="charges-panel"></div>`;

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
  $$('[data-lang-of]', body).forEach((s) => (s.onchange = () => act(() => api(`/api/platform/tenants/${s.dataset.langOf}`, json('PUT', { language: s.value })))));
  $$('[data-billing-of]', body).forEach((s) => (s.onchange = () => act(() => api(`/api/platform/tenants/${s.dataset.billingOf}`, json('PUT', { billingProvider: s.value || null })))));
  $$('[data-charges]', body).forEach((b) => (b.onclick = () => renderCharges($('#charges-panel'), Number(b.dataset.charges), b.dataset.name, Number(b.dataset.amount))));
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

// ---------- cobros a una empresa ----------
async function renderCharges(el, tenantId, name, estimate) {
  const charges = await api(`/api/platform/tenants/${tenantId}/charges`);
  el.innerHTML = `<div class="card pad charges">
    <div class="feat-head"><h3>Cobros a ${esc(name)}</h3><button class="ghost" data-close-charges>Cerrar</button></div>
    <p class="muted small">Se crea un enlace de pago con la forma de cobro de la empresa (Stripe o Mercado Pago) y tus credenciales de Ajustes. El Propietario lo ve en Configuración → Facturación.</p>
    <form id="charge-form" class="t-form">
      <input name="amount" type="number" min="0.01" step="0.01" value="${estimate > 0 ? estimate.toFixed(2) : ''}" placeholder="Importe" required />
      <input name="currency" maxlength="3" placeholder="Moneda (vacío = la de Ajustes)" />
      <input name="description" placeholder="Concepto (p. ej. Servicio de octubre)" />
      <button class="primary" type="submit">Crear enlace de pago</button>
    </form>
    <p class="muted small" id="charge-msg"></p>
    ${charges.length ? `<div class="tbl wide"><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Importe</th><th>Forma</th><th>Estado</th><th></th></tr></thead><tbody>
      ${charges.map((c) => `<tr><td>${fmtDate(c.createdAt)}</td><td>${esc(c.description)}</td><td>${c.amount.toFixed(2)} ${esc(c.currency)}</td><td>${c.provider === 'stripe' ? 'Stripe' : 'Mercado Pago'}</td>
        <td><span class="feat-status ${CHARGE_STATUS[c.status][1]}">${CHARGE_STATUS[c.status][0]}</span></td>
        <td class="actions">${c.url ? `<button class="ghost" data-copy-link="${esc(c.url)}">Copiar enlace</button>` : ''}
          ${c.status === 'pending' ? `<button class="ghost" data-refresh-charge="${c.id}">Comprobar pago</button><button class="ghost" data-charge-status="${c.id}" data-next="paid">Marcar pagado</button><button class="danger" data-charge-status="${c.id}" data-next="cancelled">Anular</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Todavía no hay cobros.</p>'}
  </div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const reload = () => renderCharges(el, tenantId, name, estimate);
  $('[data-close-charges]', el).onclick = () => (el.innerHTML = '');
  $('#charge-form').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try {
      await post(`/api/platform/tenants/${tenantId}/charges`, { amount: Number(d.amount), currency: d.currency || undefined, description: d.description });
      reload();
    } catch (err) { $('#charge-msg').textContent = `✖ ${err.message}`; }
  };
  $$('[data-copy-link]', el).forEach((b) => (b.onclick = () => navigator.clipboard.writeText(b.dataset.copyLink)));
  $$('[data-refresh-charge]', el).forEach((b) => (b.onclick = async () => {
    try { const c = await post(`/api/platform/tenants/${tenantId}/charges/${b.dataset.refreshCharge}/refresh`); if (c.status !== 'paid') alert('Todavía no consta el pago.'); } catch (err) { alert(err.message); }
    reload();
  }));
  $$('[data-charge-status]', el).forEach((b) => (b.onclick = async () => {
    if (b.dataset.next === 'cancelled' && !confirm('¿Anular este cobro?')) return;
    try { await api(`/api/platform/tenants/${tenantId}/charges/${b.dataset.chargeStatus}`, json('PUT', { status: b.dataset.next })); } catch (err) { alert(err.message); }
    reload();
  }));
}

// ---------- ajustes de la plataforma ----------
async function renderSettings(body) {
  const [{ settings, llm, billing, backend, jev }, market] = await Promise.all([api('/api/platform/settings'), api('/api/platform/marketplace')]);
  const providers = [
    { key: 'typesafe', name: 'TypeSafe (Jev)', configured: jev.configured, models: [jev.model], test: true },
    ...llm.providers.filter((p) => !p.keyless).map((p) => ({ ...p, test: true })),
    { key: 'anthropic', name: 'Anthropic (Claude Code)', configured: Boolean(settings.llmKeys.anthropic), models: [] },
  ];
  const MODES = [
    ['direct', 'Directo', 'Qwen/DeepSeek responden todo (el más barato).'],
    ['orquestado', 'Orquestado', 'Jev decide cada mensaje, Qwen/DeepSeek responden lo sencillo y Claude Code hace lo complejo.'],
    ['claude-code', 'Claude Code', 'Claude Code responde todo (el más capaz y el más caro).'],
  ];
  const keyRow = (p) => `<div class="cfg-field"><label for="k-${p.key}">${esc(p.name)} ${p.configured ? '<span class="feat-status ok">Configurada</span>' : '<span class="feat-status off">Sin clave</span>'}</label>
    <div class="row" style="margin:0"><input id="k-${p.key}" data-llm-key="${p.key}" type="password" autocomplete="off" placeholder="${esc(settings.llmKeys[p.key] ? `${settings.llmKeys[p.key]} (vacío = sin cambios)` : 'API key')}" />
    ${p.test ? `<button class="ghost" data-test="${p.key}">Probar</button>` : ''}${settings.llmKeys[p.key] ? `<button class="ghost" data-clear-key="${p.key}">Quitar</button>` : ''}</div>
    ${p.models?.length ? `<small class="muted">Modelos: ${p.models.map(esc).join(', ')}</small>` : ''}</div>`;
  const models = llm.providers.flatMap((p) => p.models.map((m) => `${p.key}:${m}`));
  body.innerHTML = `
    <div class="card pad">
      <h3>Cómo responden los agentes</h3>
      <div class="modes">${MODES.map(([v, l, d]) => `<label class="mode ${backend === v ? 'on' : ''}"><input type="radio" name="backend" value="${v}" ${backend === v ? 'checked' : ''} /> <b>${l}</b><small class="muted">${d}</small></label>`).join('')}</div>
      <p class="muted small">En modo orquestado, Jev (TypeSafe) es opcional: sin su clave, decide el propio orquestador. Dentro de Claude Code, Jev y el modelo rápido quedan disponibles como herramientas para las operaciones repetitivas.</p>
      <div class="row"><button class="primary" id="save-backend">Guardar modo</button><span class="muted small" id="backend-msg"></span></div>
    </div>
    <div class="card pad">
      <h3>Claves de IA</h3>
      <p class="muted small">Son las claves con las que das el servicio: todas tus empresas usan estas. Tus clientes no ponen claves. Se guardan cifradas y mandan sobre el .env.</p>
      ${providers.map(keyRow).join('')}
      <div class="row"><button class="primary" id="save-keys">Guardar claves</button><span class="muted small" id="keys-msg"></span></div>
    </div>
    <div class="card pad">
      <h3>Modelo para cada tarea</h3>
      <p class="muted small">Escribe <code>proveedor:modelo</code> (p. ej. <code>qwen:qwen-flash</code>). Vacío = lo del .env. En «Clasificar», <code>auto</code> usa el modelo más barato que tenga clave.</p>
      <datalist id="model-list">${models.map((m) => `<option value="${esc(m)}">`).join('')}<option value="auto"></datalist>
      <div class="plan-limits">
        <label class="cfg-field"><span>Respuestas de los agentes</span><input data-route="model" list="model-list" value="${esc(settings.llm.model ?? '')}" placeholder="${esc(llm.default)}" /></label>
        <label class="cfg-field"><span>Clasificar (temas y textos)</span><input data-route="classify" list="model-list" value="${esc(settings.llm.classify ?? '')}" placeholder="${esc(llm.classify)}" /></label>
        <label class="cfg-field"><span>Flujos y asistente</span><input data-route="flows" list="model-list" value="${esc(settings.llm.flows ?? '')}" placeholder="${esc(llm.flows)}" /></label>
        <label class="cfg-field"><span>Respaldo si falla (separados por coma)</span><input data-route="fallbacks" value="${esc((settings.llm.fallbacks ?? []).join(', '))}" placeholder="${esc(llm.fallbacks.join(', ') || 'qwen:qwen-plus')}" /></label>
      </div>
      <div class="row"><button class="primary" id="save-routes">Guardar modelos</button><span class="muted small" id="routes-msg"></span></div>
    </div>
    <div class="card pad">
      <h3>Cobro a tus clientes</h3>
      <p class="muted small">Tus cuentas de Stripe y Mercado Pago. En Empresas eliges con cuál se cobra a cada cliente.</p>
      <div class="plan-limits">
        <label class="cfg-field"><span>Stripe: clave secreta ${billing.stripe.configured ? '<span class="feat-status ok">Configurada</span>' : ''}</span><input type="password" autocomplete="off" data-bill="stripe.secretKey" placeholder="${esc(settings.billing.stripe?.secretKey ? `${settings.billing.stripe.secretKey} (vacío = sin cambios)` : 'sk_live_… o rk_live_…')}" /></label>
        <label class="cfg-field"><span>Stripe: moneda</span><input data-bill="stripe.currency" maxlength="3" value="${esc(billing.stripe.currency)}" /></label>
        <label class="cfg-field"><span>Mercado Pago: access token ${billing.mercadopago.configured ? '<span class="feat-status ok">Configurado</span>' : ''}</span><input type="password" autocomplete="off" data-bill="mercadopago.accessToken" placeholder="${esc(settings.billing.mercadopago?.accessToken ? `${settings.billing.mercadopago.accessToken} (vacío = sin cambios)` : 'APP_USR-…')}" /></label>
        <label class="cfg-field"><span>Mercado Pago: moneda</span><input data-bill="mercadopago.currency" maxlength="3" value="${esc(billing.mercadopago.currency)}" /></label>
        <label class="cfg-field"><span>Página a la que vuelve el cliente tras pagar</span><input data-bill="successUrl" value="${esc(settings.billing.successUrl ?? '')}" placeholder="https://tu-dominio.com/gracias" /></label>
      </div>
      <div class="row"><button class="primary" id="save-billing">Guardar cobro</button><span class="muted small" id="billing-msg"></span></div>
    </div>
    <div class="card pad">
      <h3>Marketplace de las webs</h3>
      <p class="muted small">Las ventas de las webs de tus clientes se cobran a nombre de cada cliente (el dinero va a su cuenta) y tú te quedas una comisión. Tus clientes solo pulsan «Conectar»: no pegan claves.</p>
      <ul class="muted small">
        <li><b>Stripe Connect</b> usa tu clave secreta de arriba. Activa Connect en tu panel de Stripe. Aviso de pagos (webhook): <code>${esc(market.stripeWebhookUrl)}</code> con los eventos <code>checkout.session.completed</code> y <code>account.updated</code>.</li>
        <li><b>Mercado Pago</b>: crea una aplicación de marketplace en Mercado Pago Developers y registra esta URL de redirección: <code>${esc(market.mpRedirectUri)}</code></li>
      </ul>
      <div class="plan-limits">
        <label class="cfg-field"><span>Tu comisión por venta (%)</span><input data-mk="feePercent" type="number" min="0" max="50" step="0.1" value="${esc(settings.billing.marketplace?.feePercent ?? 0)}" /></label>
        <label class="cfg-field"><span>Stripe: secreto del webhook ${market.stripeWebhookSigned ? '<span class="feat-status ok">Configurado</span>' : ''}</span><input type="password" autocomplete="off" data-mk="webhookSecret" placeholder="${esc(settings.billing.stripe?.webhookSecret ? `${settings.billing.stripe.webhookSecret} (vacío = sin cambios)` : 'whsec_…')}" /></label>
        <label class="cfg-field"><span>Mercado Pago: Client ID de tu app</span><input data-mk="mpClientId" inputmode="numeric" value="${esc(settings.billing.marketplace?.mpClientId ?? '')}" /></label>
        <label class="cfg-field"><span>Mercado Pago: Client secret ${market.mercadopago ? '<span class="feat-status ok">Configurado</span>' : ''}</span><input type="password" autocomplete="off" data-mk="mpClientSecret" placeholder="${esc(settings.billing.marketplace?.mpClientSecret ? `${settings.billing.marketplace.mpClientSecret} (vacío = sin cambios)` : 'Client secret')}" /></label>
      </div>
      <div class="row"><button class="primary" id="save-market">Guardar marketplace</button><span class="muted small" id="market-msg"></span></div>
    </div>`;
  const put = async (data, msgEl) => {
    try {
      const r = await api('/api/platform/settings', json('PUT', data));
      await renderSettings(body);
      $(msgEl).textContent = r.changed.length ? '✔ Guardado' : 'Sin cambios';
    } catch (err) { $(msgEl).textContent = `✖ ${err.message}`; }
  };
  $('#save-backend').onclick = () => put({ backend: body.querySelector('input[name=backend]:checked')?.value ?? '' }, '#backend-msg');
  $('#save-keys').onclick = () => put({ llmKeys: Object.fromEntries($$('[data-llm-key]', body).map((i) => [i.dataset.llmKey, i.value])) }, '#keys-msg');
  $$('[data-clear-key]', body).forEach((b) => (b.onclick = () => confirm('¿Quitar esta clave? Si no hay otra, el servicio de ese proveedor dejará de funcionar.') && put({ llmKeys: { [b.dataset.clearKey]: null } }, '#keys-msg')));
  $$('[data-test]', body).forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { const r = await post('/api/platform/settings/test', { provider: b.dataset.test }); $('#keys-msg').textContent = `${r.ok ? '✔' : '✖'} ${r.message}`; }
    catch (err) { $('#keys-msg').textContent = `✖ ${err.message}`; }
    b.disabled = false;
  }));
  $('#save-routes').onclick = () => {
    const v = Object.fromEntries($$('[data-route]', body).map((i) => [i.dataset.route, i.value.trim()]));
    put({ llm: { model: v.model, classify: v.classify, flows: v.flows, fallbacks: v.fallbacks.split(',').map((x) => x.trim()).filter(Boolean) } }, '#routes-msg');
  };
  $('#save-billing').onclick = () => {
    const billing = { stripe: {}, mercadopago: {} };
    for (const i of $$('[data-bill]', body)) {
      const [a, b] = i.dataset.bill.split('.');
      if (b) billing[a][b] = i.value.trim(); else billing[a] = i.value.trim();
    }
    put({ billing }, '#billing-msg');
  };
  $('#save-market').onclick = () => {
    const v = Object.fromEntries($$('[data-mk]', body).map((i) => [i.dataset.mk, i.value.trim()]));
    put({ billing: { stripe: { webhookSecret: v.webhookSecret }, marketplace: { feePercent: v.feePercent, mpClientId: v.mpClientId, mpClientSecret: v.mpClientSecret } } }, '#market-msg');
  };
}

// ---------- Plantillas web ----------
// Tú subes el HTML y declaras qué campos puede editar cada cliente; ellos no tocan el HTML.
const FIELD_TYPES = [['text', 'Texto'], ['textarea', 'Texto largo'], ['image', 'Imagen'], ['url', 'Enlace'], ['color', 'Color']];

async function renderTemplates(body) {
  const list = await api('/api/platform/site-templates');
  body.innerHTML = `
    <div class="card pad">
      <div class="row" style="justify-content:space-between;margin:0"><h3 style="margin:0">Plantillas web</h3>
        <span><button class="ghost" id="tpl-examples">Importar ejemplos</button> <button class="primary" id="tpl-new">Nueva plantilla</button></span></div>
      <p class="muted small">Tus clientes eligen una plantilla activa y solo editan los campos que declares. Marcadores: <code>{{clave}}</code> de cada campo, <code>{{empresa}}</code>, <code>{{#productos}}…{{/productos}}</code> con <code>{{nombre}} {{descripcion}} {{precio}} {{imagen}} {{comprar}}</code>, y <code>{{carrito}}</code>. El carrito y el pago los añade la plataforma.</p>
      <div class="tbl wide"><table><thead><tr><th>Nombre</th><th>Campos</th><th>Estado</th><th></th></tr></thead><tbody>
      ${list.map((t) => `<tr><td><b>${esc(t.name)}</b><br><small class="muted">${esc(t.description ?? '')}</small>${t.undeclared.length ? `<br><small class="feat-status warn">Sin declarar: ${t.undeclared.map(esc).join(', ')}</small>` : ''}</td>
        <td>${t.fields.map((f) => esc(f.label)).join(', ') || '—'}</td>
        <td><span class="feat-status ${t.active ? 'ok' : 'off'}">${t.active ? 'Activa' : 'Oculta'}</span></td>
        <td class="row" style="margin:0"><a class="ghost link-btn" href="/api/platform/site-templates/${t.id}/preview" target="_blank" rel="noopener">Vista previa</a><button class="ghost" data-tpl-edit="${t.id}">Editar</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aún no hay plantillas. Pulsa «Importar ejemplos» o «Nueva plantilla».</td></tr>'}
      </tbody></table></div>
    </div>
    <div id="tpl-editor"></div>`;
  $('#tpl-new').onclick = () => templateEditor(body, null);
  $$('[data-tpl-edit]', body).forEach((b) => (b.onclick = () => templateEditor(body, list.find((t) => t.id === Number(b.dataset.tplEdit)))));
  $('#tpl-examples').onclick = async () => {
    try { const r = await post('/api/platform/site-templates/examples'); await renderTemplates(body); alert(r.added.length ? `Importadas: ${r.added.join(', ')}` : 'Los ejemplos ya estaban importados.'); }
    catch (err) { alert(err.message); }
  };
}

function templateEditor(body, t) {
  const el = $('#tpl-editor');
  let fields = structuredClone(t?.fields ?? []);
  const fieldRows = () => fields.map((f, i) => `<div class="row tpl-field" data-i="${i}" style="margin:4px 0">
      <input data-f="key" value="${esc(f.key)}" placeholder="clave (p. ej. titulo)" style="max-width:150px" />
      <input data-f="label" value="${esc(f.label)}" placeholder="Etiqueta para el cliente" />
      <select data-f="type">${FIELD_TYPES.map(([v, l]) => `<option value="${v}" ${v === f.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input data-f="default" value="${esc(f.default ?? '')}" placeholder="Valor por defecto" />
      <button class="ghost" data-f-del="${i}" title="Quitar">✕</button></div>`).join('');
  const read = () => { fields = $$('.tpl-field', el).map((r) => Object.fromEntries($$('[data-f]', r).map((i) => [i.dataset.f, i.value.trim()]))).map((f) => (f.default ? f : { key: f.key, label: f.label, type: f.type })); };
  const draw = () => {
    el.innerHTML = `<div class="card pad">
      <h3>${t ? `Editar «${esc(t.name)}»` : 'Nueva plantilla'}</h3>
      <div class="plan-limits">
        <label class="cfg-field"><span>Nombre</span><input id="tpl-name" maxlength="120" value="${esc(t?.name ?? '')}" /></label>
        <label class="cfg-field"><span>Descripción</span><input id="tpl-desc" maxlength="500" value="${esc(t?.description ?? '')}" /></label>
      </div>
      <label class="switch"><input type="checkbox" id="tpl-active" ${t?.active === false ? '' : 'checked'} /><span></span>Disponible para los clientes</label>
      <h4>Campos que el cliente puede editar</h4>
      <div id="tpl-fields">${fieldRows()}</div>
      <button class="ghost" id="tpl-add-field">+ Añadir campo</button>
      <h4>HTML</h4>
      <div class="row" style="margin:0 0 6px"><input type="file" id="tpl-file" accept=".html,text/html" /><small class="muted">o pega el código:</small></div>
      <textarea id="tpl-html" rows="16" spellcheck="false" style="width:100%;font-family:monospace">${esc(t?.html ?? '')}</textarea>
      <div class="row"><button class="primary" id="tpl-save">Guardar plantilla</button><button class="ghost" id="tpl-cancel">Cancelar</button><span class="muted small" id="tpl-msg"></span></div>
    </div>`;
    $('#tpl-add-field').onclick = () => { read(); fields.push({ key: '', label: '', type: 'text' }); keep(draw); };
    $$('[data-f-del]', el).forEach((b) => (b.onclick = () => { read(); fields.splice(Number(b.dataset.fDel), 1); keep(draw); }));
    $('#tpl-file').onchange = async (e) => { const f = e.target.files[0]; if (f) $('#tpl-html').value = await f.text(); };
    $('#tpl-cancel').onclick = () => { el.innerHTML = ''; };
    $('#tpl-save').onclick = async () => {
      read();
      const data = { name: $('#tpl-name').value, description: $('#tpl-desc').value, html: $('#tpl-html').value, active: $('#tpl-active').checked, fields: fields.filter((f) => f.key) };
      try {
        await api(t ? `/api/platform/site-templates/${t.id}` : '/api/platform/site-templates', json(t ? 'PUT' : 'POST', data));
        await renderTemplates(body);
      } catch (err) { $('#tpl-msg').textContent = `✖ ${err.message}`; }
    };
  };
  // Al redibujar los campos se conserva lo escrito en nombre/HTML
  const keep = (fn) => {
    const v = { name: $('#tpl-name').value, desc: $('#tpl-desc').value, html: $('#tpl-html').value, active: $('#tpl-active').checked };
    fn();
    $('#tpl-name').value = v.name; $('#tpl-desc').value = v.desc; $('#tpl-html').value = v.html; $('#tpl-active').checked = v.active;
  };
  draw();
  el.scrollIntoView({ behavior: 'smooth' });
}
