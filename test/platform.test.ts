// Superadmin: ajustes de la plataforma (claves de IA y de cobro), idioma y forma
// de cobro de cada empresa, cobros con Stripe y Mercado Pago (simulados).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, dbAvailable } from './_helpers.ts';

const hasDb = await dbAvailable();
if (!hasDb) console.warn('⚠ Sin MariaDB de pruebas: se omiten las pruebas de la plataforma');
await setupEnv('platform', { db: hasDb });
process.env.DEEPSEEK_API_KEY = 'sk-env';
const { startTestServer, Client, tokenOf } = await import('./_server.ts');

// Proveedores externos simulados (Stripe, Mercado Pago y el LLM)
const external: { url: string; body: string; auth: string }[] = [];
let llmSystem = '';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
  external.push({ url: u, body: String(init?.body ?? ''), auth });
  const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
  if (u === 'https://api.stripe.com/v1/checkout/sessions') return json({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  if (u.startsWith('https://api.stripe.com/v1/checkout/sessions/')) return json({ id: 'cs_test_1', payment_status: 'paid' });
  if (u === 'https://api.mercadopago.com/checkout/preferences') return json({ id: 'pref_1', init_point: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_1' });
  if (u.startsWith('https://api.mercadopago.com/v1/payments/search')) return json({ results: [] });
  if (u.endsWith('/chat/completions')) {
    llmSystem = JSON.parse(String(init?.body)).messages[0].content;
    return json({ choices: [{ message: { content: 'Hello!' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  }
  if (u.endsWith('/models')) return auth === 'Bearer sk-buena' ? json({ data: [] }) : new Response('{}', { status: 401 });
  return new Response('no simulado', { status: 500 });
}) as typeof fetch;

let srv: Awaited<ReturnType<typeof startTestServer>>;
let root: InstanceType<typeof Client>, owner: InstanceType<typeof Client>;
let tenantId = 0;

before(async () => {
  if (!hasDb) return;
  srv = await startTestServer();
  root = new Client(srv.url);
  await root.register('Root', 'root@x.com');
  const plans = (await root.get('/api/platform/plans')).body.plans;
  const r = await root.post('/api/platform/tenants', { name: 'Shop', slug: 'shop', planId: plans[0].id, ownerEmail: 'o@shop.com', language: 'en', billingProvider: 'stripe' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  tenantId = r.body.tenant.id;
  owner = new Client(srv.url);
  await owner.register('Olivia', 'o@shop.com', tokenOf(r.body.invitation.link));
});
after(async () => { if (hasDb) await srv.close(); });

const opts = { skip: !hasDb };

test('solo el superadmin ve y cambia los ajustes; las claves van enmascaradas', opts, async () => {
  assert.equal((await owner.get('/api/platform/settings')).status, 403);
  const r = await root.put('/api/platform/settings', { llmKeys: { qwen: 'sk-qwen-secreta-123' }, billing: { stripe: { secretKey: 'sk_test_abc123', currency: 'usd' }, mercadopago: { accessToken: 'APP_USR-xyz789', currency: 'MXN' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed.sort(), ['billing.mercadopago.accessToken', 'billing.mercadopago.currency', 'billing.stripe.currency', 'billing.stripe.secretKey', 'llmKeys.qwen']);
  const s = (await root.get('/api/platform/settings')).body;
  assert.equal(s.settings.llmKeys.qwen, '••••-123');
  assert.equal(s.billing.stripe.configured, true);
  assert.ok(!JSON.stringify(s).includes('sk-qwen-secreta'));
  assert.ok(s.llm.providers.find((p: any) => p.key === 'qwen').configured);
  // Probar una clave
  await root.put('/api/platform/settings', { llmKeys: { groq: 'sk-buena' } });
  assert.equal((await root.post('/api/platform/settings/test', { provider: 'groq' })).body.ok, true);
});

test('el idioma de la empresa cambia el idioma de sus agentes', opts, async () => {
  const ctx = (await owner.get('/api/me/context')).body;
  assert.equal(ctx.tenant.language, 'en');
  const agent = (await owner.post('/api/agents', { name: 'Helper', instructions: 'Help customers.' })).body;
  await owner.post(`/api/agents/${agent.id}/chat`, { message: 'hi' });
  assert.match(llmSystem, /Responde en inglés/);
  await root.put(`/api/platform/tenants/${tenantId}`, { language: 'es' });
  await owner.post(`/api/agents/${agent.id}/chat`, { message: 'hola' });
  assert.match(llmSystem, /Responde en español/);
  assert.equal((await root.put(`/api/platform/tenants/${tenantId}`, { language: 'fr' })).status, 400);
});

test('cobros con Stripe: enlace de pago, el Propietario lo ve y se comprueba el pago', opts, async () => {
  const c = await root.post(`/api/platform/tenants/${tenantId}/charges`, { amount: 49.9, description: 'Servicio de octubre' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.provider, 'stripe');
  assert.equal(c.body.currency, 'USD');
  const call = external.find((e) => e.url === 'https://api.stripe.com/v1/checkout/sessions')!;
  assert.equal(call.auth, 'Bearer sk_test_abc123');
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '4990');
  assert.equal(form.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(form.get('customer_email'), 'o@shop.com');
  const bill = (await owner.get('/api/tenant/billing')).body;
  assert.equal(bill.charges[0].url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(bill.charges[0].status, 'pending');
  const refreshed = await root.post(`/api/platform/tenants/${tenantId}/charges/${c.body.id}/refresh`);
  assert.equal(refreshed.body.status, 'paid');
  // Los clientes no crean cobros ni ven los de otras empresas
  assert.equal((await owner.post(`/api/platform/tenants/${tenantId}/charges`, { amount: 1 })).status, 403);
});

test('cobros con Mercado Pago según la empresa', opts, async () => {
  await root.put(`/api/platform/tenants/${tenantId}`, { billingProvider: 'mercadopago' });
  const c = await root.post(`/api/platform/tenants/${tenantId}/charges`, { amount: 899, description: 'Servicio' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.provider, 'mercadopago');
  assert.equal(c.body.currency, 'MXN');
  const call = external.find((e) => e.url === 'https://api.mercadopago.com/checkout/preferences')!;
  assert.equal(call.auth, 'Bearer APP_USR-xyz789');
  assert.equal(JSON.parse(call.body).items[0].unit_price, 899);
  assert.equal((await root.post(`/api/platform/tenants/${tenantId}/charges/${c.body.id}/refresh`)).body.status, 'pending');
  assert.equal((await root.put(`/api/platform/tenants/${tenantId}/charges/${c.body.id}`, { status: 'paid' })).body.status, 'paid');
  // Sin forma de cobro elegida no se puede cobrar
  await root.put(`/api/platform/tenants/${tenantId}`, { billingProvider: null });
  assert.match((await root.post(`/api/platform/tenants/${tenantId}/charges`, { amount: 5 })).body.error, /Elige antes/);
  const audit = (await root.get('/api/platform/tenants')).status;
  assert.equal(audit, 200);
});
