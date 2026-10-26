// Módulos activables: plan, dependencias en cascada, rutas, herramientas del
// agente, pasos de flujo, webhooks, flujos en pausa y datos intactos al reactivar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, dbAvailable, rawDb } from './_helpers.ts';

const hasDb = await dbAvailable();
if (!hasDb) console.warn('⚠ Sin MariaDB de pruebas: se omiten las pruebas de módulos con base de datos');
const env = await setupEnv('features', { db: hasDb });
process.env.DEEPSEEK_API_KEY = 'sk-prueba'; // el LLM se simula con un fetch falso
const { startTestServer, Client, tokenOf } = await import('./_server.ts');
const { route, send, requireFeature } = await import('../src/http.ts');
const { registerAgentTool } = await import('../src/features/enforce.ts');
const registry = await import('../src/features/registry.ts');
const { validateConfig } = await import('../src/features/schema.ts');

// Una ruta y una herramienta de ejemplo del módulo CRM (la lógica real llega en su propia tarea)
route('GET', '/api/crm/ping', requireFeature('crm', 'crm.contacts.read'), async (_req, res) => send(res, 200, { ok: true }));
route('POST', '/api/crm/contacts', requireFeature('crm', 'crm.contacts.write'), async (_req, res) => send(res, 201, { ok: true }));
let toolRuns = 0;
registerAgentTool('crm', { name: 'crm_lookup_contact', description: 'Busca un contacto', parameters: { type: 'object', properties: { email: { type: 'string' } } }, run: async () => { toolRuns++; return { nombre: 'Ana' }; } });

let srv: Awaited<ReturnType<typeof startTestServer>>;
let owner: InstanceType<typeof Client>, viewer: InstanceType<typeof Client>;
let tenantId: number;

before(async () => {
  if (!hasDb) return;
  srv = await startTestServer();
  const root = new Client(srv.url);
  await root.register('Root', 'root@x.com');
  const plans = (await root.get('/api/platform/plans')).body.plans;
  const r = await root.post('/api/platform/tenants', { name: 'Tienda', slug: 'tienda', planId: plans.find((p: any) => p.key === 'basico').id, ownerEmail: 'o@t.com' });
  tenantId = r.body.tenant.id;
  owner = new Client(srv.url);
  await owner.register('Olga', 'o@t.com', tokenOf(r.body.invitation.link));
  const roles = (await owner.get('/api/tenant/roles')).body;
  const inv = await owner.post('/api/tenant/invitations', { email: 'v@t.com', roleId: roles.find((x: any) => x.systemKey === 'viewer').id });
  viewer = new Client(srv.url);
  await viewer.register('Vera', 'v@t.com', tokenOf(inv.body.link));
});

after(async () => { if (hasDb) await srv.close(); });

const opts = { skip: !hasDb };
const feature = async (key: string) => (await owner.get('/api/tenant/features')).body.features.find((f: any) => f.key === key);

test('el registro es válido y no tiene ciclos', () => {
  assert.deepEqual(registry.validateRegistry(), []);
  assert.equal(registry.FEATURES.length, 15);
  assert.deepEqual(registry.dependenciesOf('cfdi').sort(), ['crm', 'inventory', 'orders']);
  assert.deepEqual(registry.dependentsOf('crm').sort(), ['campaigns', 'cfdi', 'inbox', 'orders', 'scheduling']);
  assert.ok(registry.validateRegistry([{ ...registry.FEATURES[0], key: 'a', dependsOn: ['b'] }, { ...registry.FEATURES[0], key: 'b', dependsOn: ['a'], permissions: [] }]).some((e) => e.includes('ciclo')));
});

test('la configuración se valida con su configSchema', () => {
  const crm = registry.getFeature('crm')!;
  assert.deepEqual(validateConfig(crm.configSchema, {}), { autoCreateContacts: true, stages: ['Nuevo', 'Interesado', 'Cliente'] });
  assert.throws(() => validateConfig(crm.configSchema, { autoCreateContacts: 'sí' }), /verdadero o falso/);
  assert.throws(() => validateConfig(crm.configSchema, { otro: 1 }), /campo desconocido/);
  assert.throws(() => validateConfig(registry.getFeature('web_widget')!.configSchema, { allowedOrigins: ['javascript:alert(1)'] }), /URL/);
});

test('no se puede activar un módulo fuera del plan, ni llamando directo a la API', opts, async () => {
  const r = await owner.put('/api/tenant/features/orders', { enabled: true, cascade: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'not_in_plan');
  assert.equal((await feature('orders')).status, 'not_in_plan');
  // Los de seguridad están siempre activos y no se pueden apagar
  assert.equal((await feature('audit_log')).status, 'active');
  assert.equal((await owner.put('/api/tenant/features/encrypted_credentials', { enabled: false })).status, 400);
  // usage_billing (plataforma) solo lo gestiona el superadmin
  assert.equal((await owner.put('/api/tenant/features/usage_billing', { enabled: true })).status, 403);
});

test('dependencias: activar y desactivar en cascada se valida en el backend', opts, async () => {
  const a = await owner.put('/api/tenant/features/inbox', { enabled: true });
  assert.equal(a.status, 409);
  assert.deepEqual(a.body.requires, ['crm']);
  const b = await owner.put('/api/tenant/features/inbox', { enabled: true, cascade: true });
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.changed.map((c: any) => c.key), ['crm', 'inbox']);
  const c = await owner.put('/api/tenant/features/crm', { enabled: false });
  assert.equal(c.status, 409);
  assert.deepEqual(c.body.dependents, ['inbox']);
  const d = await owner.put('/api/tenant/features/crm', { enabled: false, cascade: true });
  assert.deepEqual(d.body.changed.map((x: any) => x.key).sort(), ['crm', 'inbox']);
  assert.equal((await feature('inbox')).enabled, false);
  // Todo queda en la auditoría con el antes y el después
  const rows = (await owner.get('/api/tenant/audit?action=feature')).body.rows;
  assert.ok(rows.filter((r: any) => r.action === 'feature.disabled').length >= 2);
  assert.ok(rows.every((r: any) => r.before && r.after));
});

test('con el módulo desactivado sus rutas responden 403; al activarlo, según el rol', opts, async () => {
  assert.equal((await owner.get('/api/crm/ping')).status, 403);
  await owner.put('/api/tenant/features/crm', { enabled: true });
  assert.equal((await owner.get('/api/crm/ping')).status, 200);
  assert.equal((await viewer.get('/api/crm/ping')).status, 200);
  assert.equal((await viewer.post('/api/crm/contacts')).status, 403); // solo lectura
  assert.equal((await owner.post('/api/crm/contacts')).status, 201);
  await owner.put('/api/tenant/features/crm', { enabled: false });
  assert.equal((await owner.get('/api/crm/ping')).status, 403, 'el bloqueo es inmediato (se vacía la caché al guardar)');
});

test('"Requiere configuración" mientras faltan las conexiones', opts, async () => {
  // Plan con todo para probar inventory (requiere shopify o woocommerce)
  const c = await rawDb(env.dbName!);
  await c.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE plan_key = 'empresa') WHERE id = ?", [tenantId]);
  await c.end();
  (await import('../src/tenancy/tenants.ts')).invalidateTenants();
  (await import('../src/authz/cache.ts')).invalidatePermissions();
  assert.equal((await owner.put('/api/tenant/features/inventory', { enabled: true })).status, 200);
  const inv = await feature('inventory');
  assert.equal(inv.status, 'needs_config');
  assert.deepEqual(inv.missingConnections, [['shopify', 'woocommerce']]);
  await owner.put('/api/connections/woocommerce', { values: { siteUrl: 'https://tienda.test', consumerKey: 'ck_1', consumerSecret: 'cs_1' } });
  assert.equal((await feature('inventory')).status, 'active');
});

// LLM simulado: la primera llamada pide la herramienta del CRM, la segunda responde
function fakeLlm(calls: { tools: string[] }[]) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('/chat/completions')) return real(url, init);
    const body = JSON.parse(String(init?.body));
    calls.push({ tools: (body.tools ?? []).map((t: any) => t.function.name) });
    const askTool = calls.length === 1;
    return new Response(JSON.stringify({
      choices: [{ message: askTool ? { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'crm_lookup_contact', arguments: '{"email":"a@b.com"}' } }] } : { content: 'Listo' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

test('las herramientas del módulo no llegan al agente si está desactivado y su llamada se rechaza y audita', opts, async () => {
  const agent = (await owner.post('/api/agents', { name: 'Vendedor', instructions: 'Vende' })).body;
  const calls: { tools: string[] }[] = [];
  let restore = fakeLlm(calls);
  try { const r = await owner.post(`/api/agents/${agent.id}/chat`, { message: 'busca a ana' }); assert.equal(r.status, 200, JSON.stringify(r.body)); } finally { restore(); }
  assert.ok(!calls[0].tools.includes('crm_lookup_contact'));
  assert.equal(toolRuns, 0);
  const blocked = (await owner.get('/api/tenant/audit?action=agent.tool_blocked')).body.rows;
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].after.tool, 'crm_lookup_contact');

  await owner.put('/api/tenant/features/crm', { enabled: true });
  calls.length = 0;
  restore = fakeLlm(calls);
  try { await owner.post(`/api/agents/${agent.id}/chat`, { message: 'busca a ana' }); } finally { restore(); }
  assert.ok(calls[0].tools.includes('crm_lookup_contact'));
  assert.equal(toolRuns, 1);
  await owner.put('/api/tenant/features/crm', { enabled: false });
});

test('un flujo que usa un módulo desactivado falla sin ejecutar nada', opts, async () => {
  const f = (await owner.post('/api/flows', {
    name: 'Con CRM', active: false, trigger: { module: 'core', key: 'manual', args: {} },
    steps: [{ id: 'antes', module: 'formato', key: 'template', args: { template: 'paso previo' } }, { id: 'crm', module: 'crm', key: 'upsert', args: {} }],
  })).body;
  const run = (await owner.post(`/api/flows/${f.id}/run`)).body;
  assert.equal(run.status, 'error');
  assert.deepEqual(run.blocked, ['crm']);
  assert.equal(run.steps.length, 1, 'no se ejecutó ningún paso');
  assert.match(run.steps[0].error, /Mini CRM/);
  // Al activarlo ya no lo bloquea (el paso previo se ejecuta)
  await owner.put('/api/tenant/features/crm', { enabled: true });
  const ok = (await owner.post(`/api/flows/${f.id}/run`)).body;
  assert.equal(ok.blocked, undefined);
  assert.equal(ok.steps[0].status, 'ok');
  await owner.put('/api/tenant/features/crm', { enabled: false });
});

test('webhooks de un flujo con módulo desactivado: 403 y registrado', opts, async () => {
  const f = (await owner.post('/api/flows', { name: 'Hook CRM', active: true, trigger: { module: 'core', key: 'webhook', args: {} }, steps: [{ id: 'crm', module: 'crm', key: 'upsert', args: {} }] })).body;
  const r = await new Client(srv.url).post(`/hooks/tienda/${f.id}`, { email: 'x@y.com' });
  assert.equal(r.status, 403);
  assert.ok((await owner.get('/api/tenant/audit?action=webhook.blocked')).body.rows.some((x: any) => x.target === `flow:${f.id}`));
});

test('los flujos programados quedan en pausa (no se borran) y se reanudan', opts, async () => {
  const { syncPausedFlows, getFlow } = await import('../src/flows.ts');
  const f = (await owner.post('/api/flows', { name: 'Programado CRM', active: true, trigger: { module: 'core', key: 'schedule', args: { everyMinutes: 60 } }, steps: [{ id: 'crm', module: 'crm', key: 'upsert', args: {} }] })).body;
  await syncPausedFlows(tenantId);
  const paused = await getFlow(tenantId, f.id);
  assert.ok(paused.paused);
  assert.deepEqual(paused.paused.features, ['crm']);
  assert.equal(paused.active, true);
  await owner.put('/api/tenant/features/crm', { enabled: true });
  await new Promise((r) => setTimeout(r, 100)); // el evento de reactivación es asíncrono
  await syncPausedFlows(tenantId);
  assert.equal((await getFlow(tenantId, f.id)).paused, undefined);
  await owner.put('/api/tenant/features/crm', { enabled: false });
  await syncPausedFlows(tenantId);
  assert.ok((await getFlow(tenantId, f.id)).paused);
});

test('al reactivar, la configuración y los datos siguen intactos', opts, async () => {
  await owner.put('/api/tenant/features/crm', { enabled: true });
  const cfg = await owner.put('/api/tenant/features/crm/config', { config: { autoCreateContacts: false, stages: ['Lead', 'Cliente'] } });
  assert.equal(cfg.status, 200);
  assert.equal((await owner.put('/api/tenant/features/crm/config', { config: { stages: 'no es lista' } })).status, 400);
  await owner.put('/api/tenant/features/crm', { enabled: false });
  await owner.put('/api/tenant/features/crm', { enabled: true });
  const crm = await feature('crm');
  assert.deepEqual(crm.config, { autoCreateContacts: false, stages: ['Lead', 'Cliente'] });
  assert.equal((await owner.get('/api/flows')).body.filter((f: any) => f.name.includes('CRM')).length, 3, 'los flujos no se borraron');
});

test('el editor oculta los pasos de módulos inactivos', opts, async () => {
  const { filterModulesForTenant } = await import('../src/features/enforce.ts');
  const mods = [{ key: 'crm', actions: [{ key: 'upsert' }], triggers: [] }, { key: 'slack', actions: [{ key: 'send' }], triggers: [] }];
  await owner.put('/api/tenant/features/crm', { enabled: false });
  assert.deepEqual((await filterModulesForTenant(tenantId, mods)).map((m) => m.key), ['slack']);
  await owner.put('/api/tenant/features/crm', { enabled: true });
  assert.deepEqual((await filterModulesForTenant(tenantId, mods)).map((m) => m.key), ['crm', 'slack']);
});

test('el contexto de la interfaz trae menú y permisos según módulos y rol', opts, async () => {
  const ctx = (await viewer.get('/api/me/context')).body;
  assert.ok(ctx.nav.includes('/crm'));
  assert.ok(!ctx.permissions.includes('crm.contacts.write'));
  await owner.put('/api/tenant/features/crm', { enabled: false, cascade: true });
  assert.ok(!(await viewer.get('/api/me/context')).body.nav.includes('/crm'));
});
