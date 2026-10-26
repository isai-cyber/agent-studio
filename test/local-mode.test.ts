// Sin MariaDB la app sigue como antes: sin login, una sola empresa y la clave data/api-key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './_helpers.ts';

await setupEnv('local-mode');
const { startTestServer, Client } = await import('./_server.ts');
const { localApiKey } = await import('../src/tenancy/apikeys.ts');
let srv: Awaited<ReturnType<typeof startTestServer>>;

before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

test('sin base de datos: sin login, todos los permisos y la clave local', async () => {
  const ui = new Client(srv.url);
  const ctx = (await ui.get('/api/me/context')).body;
  assert.equal(ctx.local, true);
  assert.equal(ctx.tenant.slug, 'default');
  assert.equal((await ui.post('/api/agents', { name: 'Local', instructions: 'x' })).status, 201);
  assert.equal((await new Client(srv.url, localApiKey()).get('/v1/agents')).status, 200);
  assert.equal((await new Client(srv.url, 'as_mala').get('/v1/agents')).status, 401);
  // Los módulos de negocio necesitan MariaDB
  assert.equal((await ui.put('/api/tenant/features/crm', { enabled: true })).status, 501);
  assert.equal((await ui.get('/api/tenant/features')).body.features.find((f: any) => f.key === 'crm').status, 'not_in_plan');
});
