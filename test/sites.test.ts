// Webs de las empresas: plantillas del superadmin, edición limitada a los campos
// declarados, catálogo, web pública (por /s/<empresa> y por dominio propio) y
// compra como marketplace (Stripe Connect y Mercado Pago, simulados).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, dbAvailable } from './_helpers.ts';

const hasDb = await dbAvailable();
if (!hasDb) console.warn('⚠ Sin MariaDB de pruebas: se omiten las pruebas de las webs');
await setupEnv('sites', { db: hasDb });
const { startTestServer, Client, tokenOf } = await import('./_server.ts');
const { renderSite, undeclaredFields, validateFields } = await import('../src/sites/render.ts');

// --- Stripe y Mercado Pago simulados
const external: { url: string; body: string; auth: string; method: string }[] = [];
let stripeReady = false;
let mpPayment: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
  external.push({ url: u, body: String(init?.body ?? ''), auth, method: init?.method ?? 'GET' });
  const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
  if (u === 'https://api.stripe.com/v1/accounts') return json({ id: 'acct_cliente1' });
  if (u === 'https://api.stripe.com/v1/accounts/acct_cliente1') return json({ id: 'acct_cliente1', charges_enabled: stripeReady });
  if (u === 'https://api.stripe.com/v1/account_links') return json({ url: 'https://connect.stripe.com/setup/e/acct_cliente1/abc' });
  if (u === 'https://api.stripe.com/v1/checkout/sessions') {
    const f = new URLSearchParams(String(init?.body));
    return json({ id: 'cs_shop_1', url: 'https://checkout.stripe.com/c/pay/cs_shop_1', metadata: { order: f.get('metadata[order]') } });
  }
  if (u === 'https://api.stripe.com/v1/checkout/sessions/cs_shop_1') {
    const created = external.find((e) => e.url === 'https://api.stripe.com/v1/checkout/sessions')!;
    return json({ id: 'cs_shop_1', payment_status: 'paid', payment_intent: 'pi_1', metadata: { order: new URLSearchParams(created.body).get('metadata[order]') } });
  }
  if (u === 'https://api.mercadopago.com/oauth/token') return json({ access_token: 'APP_USR-vendedor', refresh_token: 'TG-refresh', user_id: 998877, public_key: 'APP_USR-pk', expires_in: 15552000 });
  if (u === 'https://api.mercadopago.com/checkout/preferences') return json({ id: 'pref_shop_1', init_point: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_shop_1' });
  if (u.startsWith('https://api.mercadopago.com/v1/payments/')) return json(mpPayment);
  return new Response('no simulado', { status: 500 });
}) as typeof fetch;

let srv: Awaited<ReturnType<typeof startTestServer>>;
let root: InstanceType<typeof Client>, owner: InstanceType<typeof Client>, other: InstanceType<typeof Client>, buyer: InstanceType<typeof Client>;
let tenantId = 0;
let templateId = 0;
const products: any[] = [];

const TEMPLATE = `<!doctype html><html><head><title>{{empresa}}</title><style>:root{--c:{{color}}}</style></head><body>
<h1>{{titulo}}</h1><img src="{{portada}}"><p>{{otro}}</p>
{{#productos}}<div class="p"><h2>{{nombre}}</h2><span>{{precio}}</span>{{comprar}}</div>{{/productos}}
</body></html>`;
const FIELDS = [
  { key: 'titulo', label: 'Título', type: 'text', default: 'Hola' },
  { key: 'portada', label: 'Portada', type: 'image' },
  { key: 'color', label: 'Color', type: 'color', default: '#ff0000' },
];

before(async () => {
  if (!hasDb) return;
  srv = await startTestServer();
  root = new Client(srv.url);
  await root.register('Root', 'root@x.com');
  const plans = (await root.get('/api/platform/plans')).body.plans;
  const mk = async (name: string, slug: string, planKey: string, email: string) => {
    const r = await root.post('/api/platform/tenants', { name, slug, planId: plans.find((p: any) => p.key === planKey).id, ownerEmail: email });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = new Client(srv.url);
    await c.register(name, email, tokenOf(r.body.invitation.link));
    return { id: r.body.tenant.id, c };
  };
  const a = await mk('Tienda Ana', 'ana', 'pro', 'ana@x.com');
  tenantId = a.id;
  owner = a.c;
  other = (await mk('Otra', 'otra', 'pro', 'otra@x.com')).c;
  buyer = new Client(srv.url); // comprador anónimo: sin sesión
  for (const c of [owner, other]) assert.equal((await c.put('/api/tenant/features/web_store', { enabled: true })).status, 200);
  await root.put('/api/platform/settings', { billing: { stripe: { secretKey: 'sk_test_plataforma', currency: 'mxn' }, marketplace: { feePercent: 10, mpClientId: '123456', mpClientSecret: 'mp-secreto' } } });
});
after(async () => { if (hasDb) await srv.close(); });

const opts = { skip: !hasDb };

// fetch no deja cambiar la cabecera Host: petición con node:http
async function withHost(path: string, host: string): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http');
  const u = new URL(srv.url);
  return new Promise((ok, ko) => {
    const req = request({ hostname: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode!, body }));
    });
    req.on('error', ko);
    req.end();
  });
}

test('el motor de plantillas escapa el contenido y solo admite enlaces seguros', () => {
  const html = renderSite({
    html: TEMPLATE, fields: validateFields(FIELDS), tenantName: 'A & B',
    content: { titulo: '<script>alert(1)</script>{{carrito}}', portada: 'javascript:alert(1)', color: 'red;}body{display:none' },
    products: [{ id: 7, name: '<b>Taza</b> {{titulo}}', description: null, price: 120, image_url: null, stock: null }],
    currency: 'MXN', language: 'es', shopBase: 'https://x/s/ana', canBuy: true,
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&#123;&#123;carrito&#125;&#125;')); // un texto no puede colar marcadores
  assert.ok(html.includes('<img src="">')); // javascript: se descarta
  assert.ok(!html.includes('display:none'));
  assert.ok(html.includes('&lt;b&gt;Taza&lt;/b&gt; &#123;&#123;titulo&#125;&#125;'));
  assert.match(html, /data-as-buy="7"/);
  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /<script src="\/site-shop\.js" data-shop="https:\/\/x\/s\/ana"/);
  assert.deepEqual(undeclaredFields(TEMPLATE, validateFields(FIELDS)), ['otro']);
  assert.throws(() => validateFields([{ key: 'productos' }]), /reservada/);
});

test('solo el superadmin sube plantillas; el cliente ve las activas sin el HTML', opts, async () => {
  assert.equal((await owner.post('/api/platform/site-templates', { name: 'X', html: '<p>x</p>' })).status, 403);
  const r = await root.post('/api/platform/site-templates', { name: 'Tienda', description: 'Simple', html: TEMPLATE, fields: FIELDS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.undeclared, ['otro']);
  templateId = r.body.id;
  await root.post('/api/platform/site-templates', { name: 'Oculta', html: '<p>no</p>', fields: [], active: false });
  const ex = await root.post('/api/platform/site-templates/examples');
  assert.deepEqual(ex.body.added, ['Tienda básica']);
  assert.deepEqual((await root.post('/api/platform/site-templates/examples')).body.added, []);
  const web = (await owner.get('/api/web')).body;
  assert.deepEqual(web.templates.map((t: any) => t.name), ['Tienda', 'Tienda básica']);
  assert.equal(web.templates[0].html, undefined);
  assert.equal(web.url, `${srv.url}/s/ana`);
});

test('el módulo depende del plan', opts, async () => {
  const plans = (await root.get('/api/platform/plans')).body.plans;
  const basic = plans.find((p: any) => !p.features.includes('web_store'));
  const r = await root.post('/api/platform/tenants', { name: 'Básica', slug: 'basica', planId: basic.id, ownerEmail: 'b@x.com' });
  const c = new Client(srv.url);
  await c.register('B', 'b@x.com', tokenOf(r.body.invitation.link));
  const res = await c.get('/api/web');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'not_in_plan');
});

test('la empresa solo edita los campos declarados, arma su catálogo y publica', opts, async () => {
  // Sin plantilla no se publica
  assert.equal((await owner.put('/api/web', { published: true })).status, 400);
  const s = await owner.put('/api/web', { templateId, content: { titulo: 'Mi tienda', otro: 'colado', portada: 'https://img.example/p.jpg' }, currency: 'mxn' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.content, { titulo: 'Mi tienda', portada: 'https://img.example/p.jpg' });
  assert.equal(s.body.currency, 'MXN');
  for (const p of [{ name: 'Taza', price: 150, stock: 3 }, { name: 'Playera', price: 299.9 }, { name: 'Agotado', price: 10, stock: 0 }]) {
    const r = await owner.post('/api/web/products', p);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    products.push(r.body);
  }
  // Aún sin publicar: la web no existe
  assert.equal((await buyer.get('/s/ana')).status, 404);
  assert.equal((await owner.put('/api/web', { published: true })).status, 200);
  const page = await buyer.get('/s/ana');
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1>Mi tienda<\/h1>/);
  assert.match(page.body, /Taza/);
  assert.ok(!page.body.includes('colado'));
  // Sin cuenta de cobro conectada: catálogo sin botón de compra
  assert.ok(!page.body.includes('data-as-buy'));
  // Vista previa sin guardar
  const prev = await owner.req('POST', '/api/web/preview', { content: { titulo: 'Borrador' } });
  assert.match(prev.body, /<h1>Borrador<\/h1>/);
});

test('el superadmin decide qué plantillas ve cada tipo de cliente; cada empresa tiene su propia web', opts, async () => {
  const plans = (await root.get('/api/platform/plans')).body.plans;
  const empresa = plans.find((p: any) => p.key === 'empresa').id;
  const resto = (await root.post('/api/platform/site-templates', { name: 'Restaurante', html: '<h1>{{titulo}}</h1>', fields: [{ key: 'titulo', label: 'T', type: 'text' }], businessTypes: ['Restaurante'] })).body;
  assert.deepEqual(resto.businessTypes, ['restaurante']);
  const top = (await root.post('/api/platform/site-templates', { name: 'Premium', html: '<h1>P</h1>', fields: [], plans: [empresa] })).body;
  assert.equal((await root.post('/api/platform/site-templates', { name: 'Mala', html: '<p>x</p>', plans: [99999] })).status, 400);
  const names = async (c: InstanceType<typeof Client>) => (await c.get('/api/web')).body.templates.map((t: any) => t.name);
  // Ana (plan Pro, sin tipo de negocio) no ve ni puede elegir las dirigidas a otros
  assert.ok(!(await names(owner)).includes('Restaurante'));
  assert.ok(!(await names(owner)).includes('Premium'));
  assert.equal((await owner.put('/api/web', { templateId: resto.id })).status, 400);
  assert.equal((await owner.put('/api/web', { templateId: top.id })).status, 400);
  assert.equal((await owner.req('POST', '/api/web/preview', { templateId: top.id })).status, 400);
  // El superadmin la marca como restaurante: ahora sí la ve (Premium sigue siendo del plan Empresa)
  assert.equal((await root.put(`/api/platform/tenants/${tenantId}`, { businessType: ' Restaurante ' })).body.businessType, 'restaurante');
  assert.ok((await names(owner)).includes('Restaurante'));
  assert.ok(!(await names(owner)).includes('Premium'));
  // La otra empresa no la ve: cada una elige la suya y su web es independiente
  const otherTenant = (await other.get('/api/me/context')).body.tenant.id;
  assert.ok(!(await names(other)).includes('Restaurante'));
  await root.put(`/api/platform/tenants/${otherTenant}`, { planId: empresa });
  assert.ok((await names(other)).includes('Premium'));
  assert.equal((await other.put('/api/web', { templateId: top.id })).status, 200);
  assert.equal((await owner.get('/api/web')).body.site.templateId, templateId);
  // Si el superadmin cambia el público, quien ya la usa la conserva y puede seguir editando
  await root.put(`/api/platform/site-templates/${templateId}`, { name: 'Tienda', html: TEMPLATE, fields: FIELDS, businessTypes: ['ferreteria'] });
  assert.ok((await names(owner)).includes('Tienda'));
  assert.equal((await owner.put('/api/web', { templateId, content: { titulo: 'Mi tienda' } })).status, 200);
  assert.ok(!(await names(other)).includes('Tienda'));
  await root.put(`/api/platform/site-templates/${templateId}`, { name: 'Tienda', html: TEMPLATE, fields: FIELDS });
  await root.put(`/api/platform/tenants/${otherTenant}`, { planId: plans.find((p: any) => p.key === 'pro').id });
});

test('aislamiento: otra empresa no ve ni toca el catálogo ni la web ajena', opts, async () => {
  assert.equal((await other.put(`/api/web/products/${products[0].id}`, { name: 'Hack', price: 1 })).status, 404);
  assert.equal((await other.del(`/api/web/products/${products[0].id}`)).status, 404);
  assert.deepEqual((await other.get('/api/web/products')).body, []);
  assert.equal((await buyer.get('/s/otra')).status, 404);
});

test('Stripe Connect: alta con «Conectar» y cobro con destino y comisión', opts, async () => {
  const c = await owner.post('/api/web/payments/stripe/connect');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.url, 'https://connect.stripe.com/setup/e/acct_cliente1/abc');
  const acct = new URLSearchParams(external.find((e) => e.url === 'https://api.stripe.com/v1/accounts')!.body);
  assert.equal(acct.get('controller[fees][payer]'), 'application');
  assert.equal(acct.get('controller[stripe_dashboard][type]'), 'express');
  assert.equal(acct.get('capabilities[card_payments][requested]'), 'true');
  // Alta sin terminar: todavía no cobra
  assert.equal((await buyer.post('/s/ana/checkout', { email: 'c@x.com', items: [{ id: products[0].id, qty: 1 }] })).status, 400);
  stripeReady = true;
  const st = await owner.post('/api/web/payments/stripe/refresh');
  assert.equal(st.body.accounts.find((a: any) => a.provider === 'stripe').ready, true);
  assert.match((await buyer.get('/s/ana')).body, /data-as-buy=/);

  // Los precios salen del catálogo, no del navegador
  const r = await buyer.post('/s/ana/checkout', { name: 'Carla', email: 'c@x.com', items: [{ id: products[0].id, qty: 2, price: 0.01 }, { id: products[1].id, qty: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, 'https://checkout.stripe.com/c/pay/cs_shop_1');
  const call = external.find((e) => e.url === 'https://api.stripe.com/v1/checkout/sessions')!;
  assert.equal(call.auth, 'Bearer sk_test_plataforma');
  const f = new URLSearchParams(call.body);
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '15000');
  assert.equal(f.get('line_items[0][quantity]'), '2');
  assert.equal(f.get('line_items[1][price_data][unit_amount]'), '29990');
  assert.equal(f.get('line_items[0][price_data][currency]'), 'mxn');
  assert.equal(f.get('payment_intent_data[transfer_data][destination]'), 'acct_cliente1');
  assert.equal(f.get('payment_intent_data[on_behalf_of]'), 'acct_cliente1');
  assert.equal(f.get('payment_intent_data[application_fee_amount]'), '5999'); // 10 % de 599,90
  assert.match(f.get('success_url')!, new RegExp(`^${srv.url}/s/ana/gracias\\?pedido=[0-9a-f]{24}&session_id=\\{CHECKOUT_SESSION_ID\\}$`));

  // Sin existencias suficientes o producto agotado: no se cobra
  assert.equal((await buyer.post('/s/ana/checkout', { email: 'c@x.com', items: [{ id: products[0].id, qty: 4 }] })).status, 400);
  assert.equal((await buyer.post('/s/ana/checkout', { email: 'c@x.com', items: [{ id: products[2].id, qty: 1 }] })).status, 400);
  // Un producto de otra empresa no se puede comprar aquí
  const foreign = (await other.post('/api/web/products', { name: 'Ajeno', price: 1 })).body;
  assert.equal((await buyer.post('/s/ana/checkout', { email: 'c@x.com', items: [{ id: foreign.id, qty: 1 }] })).status, 400);

  // Vuelta del comprador: se consulta a Stripe y el pedido queda pagado una sola vez
  const ref = new URL(f.get('success_url')!.replace('{CHECKOUT_SESSION_ID}', 'cs_shop_1')).searchParams.get('pedido')!;
  const thanks = await buyer.get(`/s/ana/gracias?pedido=${ref}&session_id=cs_shop_1`);
  assert.match(thanks.body, /Pago recibido/);
  await buyer.get(`/s/ana/gracias?pedido=${ref}&session_id=cs_shop_1`);
  const orders = (await owner.get('/api/web/orders')).body;
  const o = orders.find((x: any) => x.reference === ref);
  assert.equal(o.status, 'paid');
  assert.equal(o.total, 599.9);
  assert.equal(o.platformFee, 59.99);
  assert.equal(o.customerEmail, 'c@x.com');
  const taza = (await owner.get('/api/web/products')).body.find((p: any) => p.id === products[0].id);
  assert.equal(taza.stock, 1); // 3 − 2, descontado una sola vez
  assert.deepEqual((await other.get('/api/web/orders')).body, []);
});

test('Mercado Pago marketplace: OAuth firmado y preferencia con el token del vendedor', opts, async () => {
  const c = await owner.post('/api/web/payments/mercadopago/connect');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const auth = new URL(c.body.url);
  assert.equal(auth.origin + auth.pathname, 'https://auth.mercadopago.com/authorization');
  assert.equal(auth.searchParams.get('client_id'), '123456');
  assert.equal(auth.searchParams.get('redirect_uri'), `${srv.url}/oauth/mercadopago/callback`);
  const state = auth.searchParams.get('state')!;
  // Un state manipulado se rechaza
  const forged = state.replace(/^\d+/, String(tenantId + 1));
  assert.equal((await buyer.get(`/oauth/mercadopago/callback?code=TG-x&state=${encodeURIComponent(forged)}`)).status, 400);
  const cb = await fetch(`${srv.url}/oauth/mercadopago/callback?code=TG-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/?web=pagos');
  const tok = JSON.parse(external.find((e) => e.url === 'https://api.mercadopago.com/oauth/token')!.body);
  assert.deepEqual(tok, { client_id: '123456', client_secret: 'mp-secreto', code: 'TG-code', grant_type: 'authorization_code', redirect_uri: `${srv.url}/oauth/mercadopago/callback` });
  const accts = (await owner.get('/api/web/payments')).body.accounts;
  assert.equal(accts.find((a: any) => a.provider === 'mercadopago').ready, true);
  assert.ok(!JSON.stringify(accts).includes('APP_USR-vendedor')); // el token no sale nunca

  assert.equal((await owner.put('/api/web', { paymentProvider: 'mercadopago' })).status, 200);
  const r = await buyer.post('/s/ana/checkout', { email: 'm@x.com', items: [{ id: products[1].id, qty: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /pref_id=pref_shop_1/);
  const pref = external.find((e) => e.url === 'https://api.mercadopago.com/checkout/preferences')!;
  assert.equal(pref.auth, 'Bearer APP_USR-vendedor');
  const body = JSON.parse(pref.body);
  assert.equal(body.marketplace_fee, 29.99);
  assert.equal(body.items[0].unit_price, 299.9);
  assert.equal(body.items[0].currency_id, 'MXN');
  assert.equal(body.notification_url, `${srv.url}/webhooks/mercadopago?tenant=${tenantId}`);

  // Aviso de Mercado Pago: se consulta el pago y se marca pagado
  mpPayment = { id: 555, status: 'approved', external_reference: body.external_reference };
  const wh = await buyer.req('POST', `/webhooks/mercadopago?tenant=${tenantId}`, { type: 'payment', data: { id: '555' } });
  assert.equal(wh.status, 200);
  const o = (await owner.get('/api/web/orders')).body.find((x: any) => x.reference === body.external_reference);
  assert.equal(o.status, 'paid');
  assert.equal(o.paymentId, '555');
  assert.equal(o.provider, 'mercadopago');
});

test('dominio propio: la web se sirve por el Host y Caddy solo emite TLS para dominios publicados', opts, async () => {
  assert.equal((await owner.put('/api/web', { customDomain: 'https://WWW.TiendaAna.com/' })).body.customDomain, 'www.tiendaana.com');
  assert.equal((await other.put('/api/web', { customDomain: 'www.tiendaana.com' })).status, 409);
  assert.equal((await owner.put('/api/web', { customDomain: 'no es dominio' })).status, 400);
  assert.equal((await buyer.get('/tls-allowed?domain=www.tiendaana.com')).status, 200);
  assert.equal((await buyer.get('/tls-allowed?domain=evil.com')).status, 404);
  const page = await withHost('/', 'www.tiendaana.com');
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1>Mi tienda<\/h1>/);
  assert.match(page.body, /data-shop="http:\/\/www\.tiendaana\.com"/);
  // En el dominio del cliente no existe la app ni la API
  assert.equal((await withHost('/index.html', 'www.tiendaana.com')).status, 404);
  // Al despublicar desaparece (y deja de tener TLS)
  await owner.put('/api/web', { published: false });
  const { clearDomainCache } = await import('../src/sites/routes.ts');
  clearDomainCache();
  assert.equal((await buyer.get('/s/ana')).status, 404);
  assert.equal((await buyer.get('/tls-allowed?domain=www.tiendaana.com')).status, 404);
});

test('las imágenes se suben a la carpeta de la empresa y se sirven públicamente', opts, async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const r = await fetch(`${srv.url}/api/web/upload`, { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'image/png' }, body: png });
  assert.equal(r.status, 201);
  const { url } = await r.json();
  assert.match(url, new RegExp(`^/s-media/${tenantId}/[0-9a-f-]{36}\\.png$`));
  const img = await fetch(srv.url + url);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  const bad = await fetch(`${srv.url}/api/web/upload`, { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'text/html' }, body: '<script>' });
  assert.equal(bad.status, 400);
  assert.equal((await buyer.get(`/s-media/${tenantId}/../../etc/passwd`)).status, 404);
});

test('si la empresa desactiva el módulo, su web deja de verse', opts, async () => {
  await owner.put('/api/web', { published: true });
  assert.equal((await buyer.get('/s/ana')).status, 200);
  assert.equal((await owner.put('/api/tenant/features/web_store', { enabled: false })).status, 200);
  assert.equal((await buyer.get('/s/ana')).status, 404);
  assert.equal((await owner.get('/api/web')).status, 403);
});
