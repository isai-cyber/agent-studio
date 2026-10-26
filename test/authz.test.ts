// Aislamiento entre empresas por /api, /v1, /mcp y webhooks; roles y claves de API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, dbAvailable } from './_helpers.ts';

const hasDb = await dbAvailable();
if (!hasDb) console.warn('⚠ Sin MariaDB de pruebas: se omiten las pruebas de permisos');
await setupEnv('authz', { db: hasDb });
const { startTestServer, Client, tokenOf } = await import('./_server.ts');

let srv: Awaited<ReturnType<typeof startTestServer>>;
let ana: InstanceType<typeof Client>, bob: InstanceType<typeof Client>, carla: InstanceType<typeof Client>, dani: InstanceType<typeof Client>, eva: InstanceType<typeof Client>;
let betaId: number;
const roleIds: Record<string, number> = {};
let defaultAgentId = '';
let defaultHookFlow = '';

before(async () => {
  if (!hasDb) return;
  srv = await startTestServer();
  ana = new Client(srv.url);
  assert.equal((await ana.register('Ana', 'ana@a.com')).status, 201); // primera cuenta: Propietaria de Default y superadmin
  // Empresa B con Bob como propietario (por invitación)
  const plans = (await ana.get('/api/platform/plans')).body.plans;
  const r = await ana.post('/api/platform/tenants', { name: 'Beta', slug: 'beta', planId: plans.find((p: any) => p.key === 'pro').id, ownerEmail: 'bob@b.com' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  betaId = r.body.tenant.id;
  bob = new Client(srv.url);
  assert.equal((await bob.register('Bob', 'bob@b.com', tokenOf(r.body.invitation.link))).status, 201);
  for (const role of (await bob.get('/api/tenant/roles')).body) if (role.systemKey) roleIds[role.systemKey] = role.id;
  const join = async (name: string, email: string, role: string) => {
    const inv = await bob.post('/api/tenant/invitations', { email, roleId: roleIds[role] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const c = new Client(srv.url);
    assert.equal((await c.register(name, email, tokenOf(inv.body.link))).status, 201);
    return c;
  };
  carla = await join('Carla', 'carla@b.com', 'viewer');
  dani = await join('Dani', 'dani@b.com', 'operator');
  eva = await join('Eva', 'eva@b.com', 'admin');

  defaultAgentId = (await ana.post('/api/agents', { name: 'Agente de A', instructions: 'Secreto de A' })).body.id;
  defaultHookFlow = (await ana.post('/api/flows', { name: 'Hook A', active: true, trigger: { module: 'core', key: 'webhook', args: {} }, steps: [] })).body.id;
  await ana.put('/api/connections/slack', { values: { token: 'xoxb-de-a' } });
  assert.equal((await bob.post('/api/agents', { name: 'Agente de B', instructions: 'Secreto de B' })).status, 201);
});

after(async () => { if (hasDb) await srv.close(); });

const opts = { skip: !hasDb };

test('/api: una empresa no ve ni toca los datos de otra', opts, async () => {
  assert.equal((await bob.get(`/api/agents/${defaultAgentId}`)).status, 404);
  assert.ok(!(await bob.get('/api/agents')).body.some((a: any) => a.name === 'Agente de A'));
  assert.ok(!(await ana.get('/api/agents')).body.some((a: any) => a.name === 'Agente de B'));
  assert.equal((await bob.put(`/api/agents/${defaultAgentId}/yaml`, 'name: robado\ninstructions: x\n')).status, 200); // crea uno propio con ese id...
  assert.equal((await ana.get(`/api/agents/${defaultAgentId}`)).body.instructions, 'Secreto de A'); // ...sin tocar el de A
  assert.equal((await bob.get(`/api/flows/${defaultHookFlow}`)).status, 404);
  assert.equal((await bob.post(`/api/flows/${defaultHookFlow}/run`)).status, 404);
  assert.equal((await bob.del(`/api/flows/${defaultHookFlow}`)).status, 204);
  assert.equal((await ana.get(`/api/flows/${defaultHookFlow}`)).status, 200, 'borrar en B no borra el flujo de A');
  assert.deepEqual((await bob.get('/api/connections')).body.slack, undefined);
  assert.equal((await ana.get('/api/connections')).body.slack.token, '••••de-a');
  assert.equal((await bob.get('/api/metrics')).status, 200);
  const auditB = (await bob.get('/api/tenant/audit')).body.rows;
  assert.ok(auditB.length > 0 && auditB.every((r: any) => r.tenantId === betaId));
  assert.ok(!auditB.some((r: any) => r.action === 'connection.saved'));
  // No puede cambiarse a la empresa de A
  assert.equal((await bob.post('/api/me/tenant', { tenantId: 1 })).status, 403);
  assert.equal((await bob.get('/api/platform/tenants')).status, 403);
});

test('webhooks: la ruta de una empresa no ejecuta flujos de otra', opts, async () => {
  assert.equal((await new Client(srv.url).post(`/hooks/beta/${defaultHookFlow}`)).status, 404);
  assert.equal((await new Client(srv.url).post(`/hooks/default/${defaultHookFlow}`)).status, 200);
  const old = await new Client(srv.url).post(`/hooks/${defaultHookFlow}`);
  assert.equal(old.status, 200);
  assert.equal(old.headers.get('deprecation'), 'true');
});

test('/v1 y /mcp: la clave de una empresa solo ve esa empresa', opts, async () => {
  const k = await bob.post('/api/tenant/apikeys', { name: 'todo', scopes: ['agents.read', 'agents.manage', 'flows.manage', 'metrics.read'] });
  assert.equal(k.status, 201);
  const api = new Client(srv.url, k.body.key);
  const agents = (await api.get('/v1/agents')).body.data;
  assert.ok(agents.length >= 1 && !agents.some((a: any) => a.name === 'Agente de A'));
  assert.equal((await api.get(`/v1/agents/${defaultAgentId}`)).body.name, 'robado'); // el suyo, no el de A
  assert.equal((await api.post(`/v1/flows/${defaultHookFlow}/run`, {})).status, 404);
  assert.equal((await api.get('/v1/models')).body.data.length, agents.length);
  const list = await api.mcp('tools/call', { name: 'list_agents', arguments: {} });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const text = list.body.result.content[0].text;
  assert.ok(!text.includes('Agente de A'));
  const get = await api.mcp('tools/call', { name: 'get_agent', arguments: { agent_id: defaultAgentId } });
  assert.ok(!JSON.stringify(get.body).includes('Secreto de A'));
});

test('Solo lectura no puede escribir', opts, async () => {
  assert.equal((await carla.get('/api/agents')).status, 200);
  assert.equal((await carla.post('/api/agents', { name: 'x', instructions: 'y' })).status, 403);
  assert.equal((await carla.put('/api/connections/slack', { values: { token: 'x' } })).status, 403);
  assert.equal((await carla.post('/api/flows', { name: 'x' })).status, 403);
  assert.equal((await carla.get('/api/tenant/audit')).status, 200); // audit.read es lectura
});

test('Operador no puede cambiar la configuración', opts, async () => {
  assert.equal((await dani.get('/api/agents')).status, 200);
  assert.equal((await dani.put('/api/tenant/features/crm', { enabled: true })).status, 403);
  assert.equal((await dani.post('/api/tenant/invitations', { email: 'z@b.com', roleId: roleIds.viewer })).status, 403);
  assert.equal((await dani.put('/api/connections/slack', { values: { token: 'x' } })).status, 403);
  assert.equal((await dani.post('/api/tenant/roles', { name: 'Yo', permissions: [] })).status, 403);
});

test('Admin no puede eliminar la empresa ni tocar al Propietario', opts, async () => {
  assert.equal((await eva.del('/api/tenant', { confirm: 'beta' })).status, 403);
  assert.equal((await eva.get('/api/tenant/billing')).status, 403);
  const bobId = (await bob.get('/api/me/context')).body.user.id;
  assert.equal((await eva.put(`/api/tenant/users/${bobId}/role`, { roleId: roleIds.viewer })).status, 403);
  assert.equal((await eva.del(`/api/tenant/users/${bobId}`)).status, 403);
  // Tampoco puede nombrar Propietarios ni dar permisos que no tiene
  assert.equal((await eva.post('/api/tenant/invitations', { email: 'z@b.com', roleId: roleIds.owner })).status, 403);
  assert.equal((await eva.post('/api/tenant/roles', { name: 'Casi dueño', permissions: ['tenant.delete'] })).status, 403);
  assert.equal((await eva.post('/api/tenant/apikeys', { name: 'k', scopes: ['tenant.delete'] })).status, 403);
  // Pero sí gestiona usuarios normales
  const carlaId = (await carla.get('/api/me/context')).body.user.id;
  assert.equal((await eva.put(`/api/tenant/users/${carlaId}/role`, { roleId: roleIds.operator })).status, 200);
  assert.equal((await eva.put(`/api/tenant/users/${carlaId}/role`, { roleId: roleIds.viewer })).status, 200);
});

test('no se le puede quitar el rol al último Propietario', opts, async () => {
  const bobId = (await bob.get('/api/me/context')).body.user.id;
  const r = await bob.put(`/api/tenant/users/${bobId}/role`, { roleId: roleIds.admin });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /último Propietario/);
  assert.equal((await bob.del(`/api/tenant/users/${bobId}`)).status, 409);
  // Con un segundo Propietario, sí
  const evaId = (await eva.get('/api/me/context')).body.user.id;
  assert.equal((await bob.put(`/api/tenant/users/${evaId}/role`, { roleId: roleIds.owner })).status, 200);
  assert.equal((await eva.put(`/api/tenant/users/${evaId}/role`, { roleId: roleIds.admin })).status, 200);
});

test('roles propios: clonar y matriz de permisos', opts, async () => {
  const r = await bob.post('/api/tenant/roles', { name: 'Soporte', cloneFrom: roleIds.viewer });
  assert.equal(r.status, 201);
  assert.ok(r.body.permissions.every((p: string) => p.endsWith('.read')));
  const u = await bob.put(`/api/tenant/roles/${r.body.id}`, { permissions: ['agents.read', 'crm.contacts.write'] });
  assert.deepEqual(u.body.permissions.sort(), ['agents.read', 'crm.contacts.write']);
  assert.equal((await bob.put(`/api/tenant/roles/${roleIds.admin}`, { permissions: [] })).status, 400); // los del sistema no se editan
  assert.equal((await bob.put(`/api/tenant/roles/${r.body.id}`, { permissions: ['no.existe.nunca'] })).status, 400);
  // Un rol de B no existe para A
  assert.equal((await ana.put(`/api/tenant/roles/${r.body.id}`, { name: 'x' })).status, 404);
  assert.equal((await bob.del(`/api/tenant/roles/${r.body.id}`)).status, 204);
});

test('claves de API: no superan sus scopes y revocadas dejan de funcionar', opts, async () => {
  const k = await bob.post('/api/tenant/apikeys', { name: 'solo lectura', scopes: ['agents.read'] });
  const api = new Client(srv.url, k.body.key);
  assert.equal((await api.get('/v1/agents')).status, 200);
  assert.equal((await api.post('/v1/agents', { name: 'x', instructions: 'y' })).status, 403);
  assert.equal((await api.get('/v1/metrics')).status, 403);
  assert.equal((await api.post(`/v1/flows/x/run`, {})).status, 403);
  const tools = (await api.mcp('tools/list')).body.result.tools.map((t: any) => t.name);
  assert.ok(tools.includes('list_agents') && !tools.includes('create_agent'));
  // La clave no se guarda en claro ni se vuelve a mostrar
  const listed = (await bob.get('/api/tenant/apikeys')).body.find((x: any) => x.id === k.body.info.id);
  assert.equal(listed.key, undefined);
  assert.ok(k.body.key.startsWith(listed.prefix));
  assert.equal((await bob.del(`/api/tenant/apikeys/${k.body.info.id}`)).status, 204);
  assert.equal((await api.get('/v1/agents')).status, 401);
  assert.equal((await api.mcp('tools/list')).status, 401);
  // Una empresa no revoca claves de otra
  assert.equal((await ana.del(`/api/tenant/apikeys/${k.body.info.id}`)).status, 404);
});

test('superadmin: suspender una empresa y entrar como soporte queda en la auditoría', opts, async () => {
  assert.equal((await ana.put(`/api/platform/tenants/${betaId}`, { status: 'suspended' })).status, 200);
  assert.equal((await bob.get('/api/agents')).status, 403);
  assert.equal((await new Client(srv.url).post(`/hooks/beta/x`)).status, 404);
  assert.equal((await ana.put(`/api/platform/tenants/${betaId}`, { status: 'active' })).status, 200);
  assert.equal((await bob.get('/api/agents')).status, 200);
  assert.equal((await ana.post(`/api/platform/tenants/${betaId}/support`)).status, 200);
  const ctx = (await ana.get('/api/me/context')).body;
  assert.equal(ctx.tenant.id, betaId);
  assert.equal(ctx.support, true);
  assert.ok(!ctx.permissions.includes('tenant.delete'));
  assert.ok((await ana.get('/api/agents')).body.some((a: any) => a.name === 'Agente de B'));
  assert.ok((await bob.get('/api/tenant/audit?action=support')).body.rows.some((r: any) => r.action === 'support.entered' && r.actorType === 'superadmin'));
  await ana.post('/api/platform/support/exit');
  assert.equal((await ana.get('/api/me/context')).body.tenant.id, 1);
});

test('auditoría: inicios de sesión, solo lectura y CSV', opts, async () => {
  const c = new Client(srv.url);
  assert.equal((await c.post('/api/auth/login', { email: 'carla@b.com', password: 'clave-segura-123' })).status, 200);
  const rows = (await bob.get('/api/tenant/audit?action=auth.login')).body.rows;
  assert.ok(rows.some((r: any) => r.actorEmail === 'carla@b.com'));
  const csv = await bob.get('/api/tenant/audit.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type')!, /text\/csv/);
  assert.match(csv.body, /fecha,actor,tipo_actor,accion/);
  // No hay forma de modificar ni borrar la auditoría, ni siquiera como Propietario
  for (const m of ['PUT', 'DELETE', 'POST']) assert.equal((await bob.req(m, '/api/tenant/audit')).status, 404);
});
