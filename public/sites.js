// Mi web: la empresa elige una plantilla (las sube el superadmin), edita solo sus
// campos, gestiona el catálogo, ve los pedidos y conecta su cuenta de cobro
// (Stripe o Mercado Pago, como marketplace: el dinero va a su cuenta).
import { can } from './context.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });
const fmtDate = (d) => (d ? new Date(d).toLocaleString(document.documentElement.lang === 'en' ? 'en' : 'es', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const money = (n, c) => { try { return new Intl.NumberFormat(document.documentElement.lang === 'en' ? 'en-US' : 'es-MX', { style: 'currency', currency: c }).format(n); } catch { return `${n} ${c}`; } };
const ORDER_STATUS = { pending: ['Pendiente', 'warn'], paid: ['Pagado', 'ok'], cancelled: ['Anulado', 'off'] };

let api;
let tab = 'page';

const TABS = [
  { k: 'page', label: 'Página', show: () => can('web_store.site.read') },
  { k: 'products', label: 'Catálogo', show: () => can('web_store.products.read') },
  { k: 'orders', label: 'Pedidos', show: () => can('web_store.orders.read') },
  { k: 'payments', label: 'Cobros', show: () => can('web_store.payments.manage') },
];

export function initSites(apiFn) {
  api = apiFn;
}

export async function loadSitesView(which) {
  const visible = TABS.filter((t) => t.show());
  if (which) tab = which === 'pagos' ? 'payments' : which;
  if (!visible.some((t) => t.k === tab)) tab = visible[0]?.k;
  $('#web-tabs').innerHTML = visible.map((t) => `<button data-web-tab="${t.k}" class="${t.k === tab ? 'active' : ''}">${esc(t.label)}</button>`).join('');
  $$('[data-web-tab]').forEach((b) => (b.onclick = () => loadSitesView(b.dataset.webTab)));
  const body = $('#web-body');
  body.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    await { page: renderPage, products: renderProducts, orders: renderOrders, payments: renderPayments }[tab](body);
  } catch (e) {
    body.innerHTML = `<div class="m-banner warn-banner">✖ ${esc(e.message)}</div>`;
  }
}

async function upload(file) {
  const r = await fetch('/api/web/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data.url;
}

// ---------- Página ----------
async function renderPage(body) {
  const data = await api('/api/web');
  const { site } = data;
  const edit = can('web_store.site.write');
  let templateId = site.templateId;
  const fieldInput = (f) => {
    const v = site.content[f.key] ?? f.default ?? '';
    const id = `wf-${f.key}`;
    const dis = edit ? '' : 'disabled';
    if (f.type === 'textarea') return `<textarea id="${id}" data-wf="${esc(f.key)}" rows="3" ${dis}>${esc(v)}</textarea>`;
    if (f.type === 'color') return `<input id="${id}" data-wf="${esc(f.key)}" type="color" value="${esc(v || '#2563eb')}" ${dis} />`;
    if (f.type === 'image') return `<div class="row" style="margin:0"><input id="${id}" data-wf="${esc(f.key)}" type="url" value="${esc(v)}" placeholder="https://… o sube una imagen" ${dis} />${edit ? `<input type="file" accept="image/*" data-wf-upload="${esc(f.key)}" />` : ''}</div>`;
    return `<input id="${id}" data-wf="${esc(f.key)}" type="${f.type === 'url' ? 'url' : 'text'}" value="${esc(v)}" ${dis} />`;
  };
  const tpl = () => data.templates.find((t) => t.id === templateId) ?? data.template;
  body.innerHTML = `
    <div class="card pad">
      <h3>1. Elige una plantilla</h3>
      ${data.templates.length ? `<div class="tpl-pick">${data.templates.map((t) => `<label class="${t.id === templateId ? 'on' : ''}"><input type="radio" name="tpl" value="${t.id}" ${t.id === templateId ? 'checked' : ''} ${edit ? '' : 'disabled'} hidden /><b>${esc(t.name)}</b><br><small class="muted">${esc(t.description ?? '')}</small></label>`).join('')}</div>`
        : '<p class="muted">Todavía no hay plantillas disponibles. Pídele al administrador de la plataforma que suba alguna.</p>'}
    </div>
    <div class="web-grid">
      <div class="card pad">
        <h3>2. Personaliza</h3>
        <form id="web-form"></form>
        <h3>3. Publica</h3>
        <div class="plan-limits">
          <label class="cfg-field"><span>Moneda</span><input id="web-currency" maxlength="3" value="${esc(site.currency)}" ${edit ? '' : 'disabled'} /></label>
          <label class="cfg-field"><span>Dominio propio (opcional)</span><input id="web-domain" value="${esc(site.customDomain ?? '')}" placeholder="www.mitienda.com" ${edit ? '' : 'disabled'} /></label>
        </div>
        ${data.domainTarget ? `<p class="muted small">Para usar tu dominio crea un registro <b>CNAME</b> que apunte a <code>${esc(data.domainTarget)}</code>. El certificado HTTPS se emite solo.</p>` : ''}
        <label class="switch"><input type="checkbox" id="web-published" ${site.published ? 'checked' : ''} ${edit ? '' : 'disabled'} /><span></span>Web publicada</label>
        <p class="small">Dirección: <a href="${esc(data.url)}" target="_blank" rel="noopener">${esc(data.url)}</a>${site.customDomain ? ` · <a href="https://${esc(site.customDomain)}" target="_blank" rel="noopener">${esc(site.customDomain)}</a>` : ''}</p>
        ${data.provider ? '' : '<p class="m-banner warn-banner small">Tu web aún no puede cobrar: conecta Stripe o Mercado Pago en «Cobros». Mientras tanto se ve el catálogo sin botón de compra.</p>'}
        ${edit ? '<div class="row"><button class="primary" id="web-save">Guardar</button><span class="muted small" id="web-msg"></span></div>' : ''}
      </div>
      <div><iframe id="web-preview" title="Vista previa" sandbox="allow-same-origin"></iframe></div>
    </div>`;
  const values = () => Object.fromEntries($$('[data-wf]', body).map((i) => [i.dataset.wf, i.value]));
  const preview = async () => {
    if (!templateId) { $('#web-preview').srcdoc = '<p style="font-family:sans-serif;padding:24px;color:#888">Elige una plantilla para ver la vista previa.</p>'; return; }
    try {
      const html = await api('/api/web/preview', json('POST', { templateId, content: values() }));
      $('#web-preview').srcdoc = html;
    } catch (e) { $('#web-preview').srcdoc = `<p style="font-family:sans-serif;padding:24px">${esc(e.message)}</p>`; }
  };
  const drawFields = () => {
    const t = tpl();
    $('#web-form').innerHTML = t ? t.fields.map((f) => `<div class="cfg-field"><label for="wf-${esc(f.key)}">${esc(f.label)}</label>${fieldInput(f)}</div>`).join('') || '<p class="muted small">Esta plantilla no tiene campos editables.</p>' : '<p class="muted small">Elige una plantilla.</p>';
    $$('[data-wf-upload]', body).forEach((inp) => (inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try { $(`#wf-${inp.dataset.wfUpload}`).value = await upload(f); preview(); } catch (e) { alert(e.message); }
    }));
    let timer;
    $$('[data-wf]', body).forEach((i) => (i.oninput = () => { clearTimeout(timer); timer = setTimeout(preview, 500); }));
    preview();
  };
  $$('input[name=tpl]', body).forEach((r) => (r.onchange = () => {
    templateId = Number(r.value);
    $$('.tpl-pick label', body).forEach((l) => l.classList.toggle('on', l.contains(r)));
    drawFields();
  }));
  drawFields();
  $('#web-save')?.addEventListener('click', async () => {
    const msg = $('#web-msg');
    try {
      await api('/api/web', json('PUT', { templateId, content: values(), currency: $('#web-currency').value.trim(), customDomain: $('#web-domain').value.trim() || null, published: $('#web-published').checked }));
      msg.textContent = '✔ Guardado';
    } catch (e) { msg.textContent = `✖ ${e.message}`; }
  });
}

// ---------- Catálogo ----------
async function renderProducts(body) {
  const [list, data] = await Promise.all([api('/api/web/products'), api('/api/web')]);
  const edit = can('web_store.products.write');
  body.innerHTML = `
    <div class="card pad">
      <div class="row" style="justify-content:space-between;margin:0"><h3 style="margin:0">Catálogo</h3>${edit ? '<button class="primary" id="prod-new">Nuevo producto</button>' : ''}</div>
      <div id="prod-editor"></div>
      <div class="tbl wide"><table><thead><tr><th></th><th>Producto</th><th>Precio</th><th>Existencias</th><th>Estado</th><th></th></tr></thead><tbody>
      ${list.map((p) => `<tr><td>${p.image_url ? `<img class="prod-img" src="${esc(p.image_url)}" alt="" />` : ''}</td><td><b>${esc(p.name)}</b><br><small class="muted">${esc((p.description ?? '').slice(0, 90))}</small></td>
        <td>${money(p.price, data.site.currency)}</td><td>${p.stock === null ? '∞' : p.stock}</td>
        <td><span class="feat-status ${p.active ? 'ok' : 'off'}">${p.active ? 'Visible' : 'Oculto'}</span></td>
        <td>${edit ? `<button class="ghost" data-prod-edit="${p.id}">Editar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aún no hay productos.</td></tr>'}
      </tbody></table></div>
    </div>`;
  const editor = (p) => {
    const el = $('#prod-editor');
    el.innerHTML = `<form class="card pad" id="prod-form">
      <div class="plan-limits">
        <label class="cfg-field"><span>Nombre</span><input name="name" required maxlength="160" value="${esc(p?.name ?? '')}" /></label>
        <label class="cfg-field"><span>Precio (${esc(data.site.currency)})</span><input name="price" type="number" min="0" step="0.01" required value="${esc(p?.price ?? '')}" /></label>
        <label class="cfg-field"><span>Existencias (vacío = sin límite)</span><input name="stock" type="number" min="0" step="1" value="${esc(p?.stock ?? '')}" /></label>
        <label class="cfg-field"><span>Orden</span><input name="sort" type="number" step="1" value="${esc(p?.sort ?? 0)}" /></label>
      </div>
      <div class="cfg-field"><label>Descripción</label><textarea name="description" rows="3" maxlength="5000">${esc(p?.description ?? '')}</textarea></div>
      <div class="cfg-field"><label>Imagen</label><div class="row" style="margin:0"><input name="image_url" type="url" value="${esc(p?.image_url ?? '')}" placeholder="https://… o sube una imagen" /><input type="file" accept="image/*" id="prod-file" /></div></div>
      <label class="switch"><input type="checkbox" name="active" ${p?.active === false ? '' : 'checked'} /><span></span>Visible en la web</label>
      <div class="row"><button class="primary" type="submit">Guardar</button><button class="ghost" type="button" id="prod-cancel">Cancelar</button>${p ? '<button class="ghost danger" type="button" id="prod-del">Ocultar producto</button>' : ''}<span class="muted small" id="prod-msg"></span></div>
    </form>`;
    const f = $('#prod-form');
    $('#prod-file').onchange = async (e) => { try { f.image_url.value = await upload(e.target.files[0]); } catch (err) { $('#prod-msg').textContent = `✖ ${err.message}`; } };
    $('#prod-cancel').onclick = () => { el.innerHTML = ''; };
    $('#prod-del')?.addEventListener('click', async () => { await api(`/api/web/products/${p.id}`, { method: 'DELETE' }); renderProducts(body); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = { name: f.name.value, price: f.price.value, stock: f.stock.value === '' ? null : f.stock.value, sort: f.sort.value, description: f.description.value, image_url: f.image_url.value, active: f.active.checked };
      try {
        await api(p ? `/api/web/products/${p.id}` : '/api/web/products', json(p ? 'PUT' : 'POST', d));
        renderProducts(body);
      } catch (err) { $('#prod-msg').textContent = `✖ ${err.message}`; }
    };
  };
  $('#prod-new')?.addEventListener('click', () => editor(null));
  $$('[data-prod-edit]', body).forEach((b) => (b.onclick = () => editor(list.find((p) => p.id === Number(b.dataset.prodEdit)))));
}

// ---------- Pedidos ----------
async function renderOrders(body) {
  const list = await api('/api/web/orders');
  body.innerHTML = `<div class="card pad"><h3>Pedidos</h3>
    <div class="tbl wide"><table><thead><tr><th>Fecha</th><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Total</th><th>Comisión</th><th>Cobro</th><th>Estado</th></tr></thead><tbody>
    ${list.map((o) => { const [l, c] = ORDER_STATUS[o.status] ?? [o.status, 'off']; return `<tr><td>${fmtDate(o.createdAt)}</td><td><code>${esc(o.reference.slice(-8).toUpperCase())}</code></td>
      <td>${esc(o.customerName ?? '')}<br><small class="muted">${esc(o.customerEmail ?? '')}</small></td>
      <td>${o.items.map((i) => `${i.qty} × ${esc(i.name)}`).join('<br>')}</td><td>${money(o.total, o.currency)}</td><td>${money(o.platformFee, o.currency)}</td>
      <td>${o.provider === 'stripe' ? 'Stripe' : 'Mercado Pago'}</td><td><span class="feat-status ${c}">${l}</span></td></tr>`; }).join('') || '<tr><td colspan="8" class="muted">Aún no hay pedidos.</td></tr>'}
    </tbody></table></div></div>`;
}

// ---------- Cobros ----------
async function renderPayments(body, retryStripe = false) {
  const [{ accounts, platform }, data] = await Promise.all([api('/api/web/payments'), api('/api/web')]);
  const by = Object.fromEntries(accounts.map((a) => [a.provider, a]));
  const state = (a) => (a.ready ? '<span class="feat-status ok">Conectada · lista para cobrar</span>' : a.connected ? '<span class="feat-status warn">Alta sin terminar</span>' : '<span class="feat-status off">Sin conectar</span>');
  const card = (key, name, available, help) => `<div class="card pad">
      <h3>${name} ${state(by[key])}</h3>
      <p class="muted small">${help}</p>
      ${!available ? '<p class="muted small">El administrador de la plataforma aún no lo ha habilitado.</p>' : `<div class="row">
        <button class="primary" data-connect="${key}">${by[key].ready ? 'Revisar cuenta' : by[key].connected ? 'Continuar alta' : `Conectar ${name}`}</button>
        ${key === 'stripe' && by[key].connected ? '<button class="ghost" id="stripe-check">Comprobar estado</button>' : ''}
        ${by[key].connected ? `<button class="ghost danger" data-disconnect="${key}">Desconectar</button>` : ''}
        <label class="switch" style="margin-left:auto"><input type="radio" name="prov" value="${key}" ${data.provider === key ? 'checked' : ''} ${by[key].ready ? '' : 'disabled'} /><span></span>Cobrar con ${name}</label></div>`}
    </div>`;
  body.innerHTML = `
    <p class="muted">Las ventas de tu web se cobran directamente en <b>tu</b> cuenta. ${platform.feePercent ? `La plataforma retiene una comisión del ${platform.feePercent}% por venta.` : ''} No tienes que copiar ninguna clave: pulsa «Conectar» y sigue los pasos.</p>
    ${card('stripe', 'Stripe', platform.stripe, 'Tarjetas de crédito y débito. Stripe te pedirá tus datos y tu cuenta bancaria.')}
    ${card('mercadopago', 'Mercado Pago', platform.mercadopago, 'Tarjetas, saldo de Mercado Pago, OXXO y más. Inicia sesión con tu cuenta de Mercado Pago y autoriza.')}
    <span class="muted small" id="pay-msg"></span>`;
  const msg = $('#pay-msg');
  const connect = async (key) => {
    try {
      const { url } = await api(`/api/web/payments/${key}/connect`, json('POST'));
      location.href = url;
    } catch (e) { msg.textContent = `✖ ${e.message}`; }
  };
  $$('[data-connect]', body).forEach((b) => (b.onclick = () => connect(b.dataset.connect)));
  $$('[data-disconnect]', body).forEach((b) => (b.onclick = async () => {
    if (!confirm('¿Desconectar esta cuenta? Tu web dejará de cobrar con ella.')) return;
    await api(`/api/web/payments/${b.dataset.disconnect}`, { method: 'DELETE' });
    renderPayments(body);
  }));
  $('#stripe-check')?.addEventListener('click', async () => {
    try { await api('/api/web/payments/stripe/refresh', json('POST')); renderPayments(body); } catch (e) { msg.textContent = `✖ ${e.message}`; }
  });
  $$('input[name=prov]', body).forEach((r) => (r.onchange = async () => {
    try { await api('/api/web', json('PUT', { paymentProvider: r.value })); msg.textContent = '✔ Guardado'; } catch (e) { msg.textContent = `✖ ${e.message}`; }
  }));
  // Volviendo del alta de Stripe: se consulta el estado (o se pide un enlace nuevo si caducó)
  if (retryStripe) connect('stripe');
  else if (by.stripe.connected && !by.stripe.ready && platform.stripe) api('/api/web/payments/stripe/refresh', json('POST')).then((r) => { if (r.accounts.find((a) => a.provider === 'stripe')?.ready) renderPayments(body); }).catch(() => {});
}

// Llamado al volver de Stripe / Mercado Pago (?web=pagos)
export function retryStripeOnboarding() {
  tab = 'payments';
  return renderPayments($('#web-body'), true);
}
