// Aislamiento en el almacenamiento: cada empresa solo ve sus agentes, flujos,
// conexiones, métricas y sesiones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setupEnv } from './_helpers.ts';

const env = await setupEnv('isolation-storage');
const store = await import('../src/store.ts');
const flows = await import('../src/flows.ts');
const conns = await import('../src/connections.ts');
const metrics = await import('../src/metrics.ts');
const engine = await import('../src/engine.ts');
const { search } = await import('../src/knowledge.ts');

test('agentes: mismo id en dos empresas sin choques', async () => {
  await store.saveAgent(1, { id: 'soporte', name: 'Soporte A', instructions: 'A' });
  await store.saveAgent(2, { id: 'soporte', name: 'Soporte B', instructions: 'B' });
  assert.equal((await store.getAgent(1, 'soporte')).name, 'Soporte A');
  assert.equal((await store.getAgent(2, 'soporte')).name, 'Soporte B');
  assert.deepEqual((await store.listAgents(2)).map((a) => a.name), ['Soporte B']);
  await assert.rejects(store.getAgent(3, 'soporte'), /no encontrado/);
  // El tenantId no se guarda en el YAML
  assert.ok(!(await readFile(join(env.agentsDir, '1', 'soporte', 'agent.yaml'), 'utf8')).includes('tenantId'));
  // Un agente cargado de una empresa no se puede guardar en otra
  const a = await store.getAgent(1, 'soporte');
  await assert.rejects(store.saveAgent(2, a), /otra empresa/);
});

test('flujos y ejecuciones por empresa', async () => {
  const f = await flows.saveFlow(1, { name: 'Flujo A', steps: [] });
  await assert.rejects(flows.getFlow(2, f.id), /no encontrado/);
  assert.equal((await flows.listFlows(2)).length, 0);
  const run = await flows.runFlow(await flows.getFlow(1, f.id), { x: 1 }, 'manual');
  assert.equal(run.status, 'ok');
  assert.equal((await flows.listRuns(1, f.id)).length, 1);
  assert.equal((await flows.listRuns(2, f.id)).length, 0);
  await assert.rejects(flows.getFlow(1, '../2/flows/x'), /inválido/);
});

test('conexiones cifradas y separadas', async () => {
  await conns.setConnection(1, 'slack', { token: 'xoxb-secreto-de-a' });
  assert.equal((await conns.getConnection(1, 'slack')).token, 'xoxb-secreto-de-a');
  assert.deepEqual(await conns.getConnection(2, 'slack'), {});
  const raw = await readFile(join(env.dataDir, 'tenants', '1', 'connections.json'), 'utf8');
  assert.ok(!raw.includes('xoxb-secreto-de-a'), 'el archivo no debe tener secretos en claro');
  // Copiar el archivo de una empresa a otra no sirve: la clave es distinta
  await mkdir(join(env.dataDir, 'tenants', '2'), { recursive: true });
  await writeFile(join(env.dataDir, 'tenants', '2', 'connections.json'), raw);
  assert.deepEqual(await conns.getConnection(2, 'slack'), {});
  const masked = await conns.listMasked(1, { slack: ['token'] });
  assert.equal(masked.slack.token, '••••de-a');
});

test('las variables FLOW_* del .env solo llegan a la empresa Default', async () => {
  process.env.FLOW_SLACK_TOKEN = 'env-token';
  assert.equal((await conns.getConnection(1, 'github', ['token'])).token, undefined);
  assert.equal((await conns.getConnection(3, 'slack', ['token'])).token, undefined);
  const { flowEnv } = await import('../src/modules/sdk.ts');
  assert.equal(flowEnv(1).FLOW_SLACK_TOKEN, 'env-token');
  assert.deepEqual(flowEnv(2), {});
  delete process.env.FLOW_SLACK_TOKEN;
});

test('métricas por empresa', async () => {
  await metrics.recordTts(1, 'soporte', 100, 5);
  assert.equal((await metrics.readEvents(1)).events.length, 1);
  assert.equal((await metrics.readEvents(2)).events.length, 0);
});

test('una sesión de chat no se comparte entre empresas', async () => {
  const a = await store.getAgent(1, 'soporte');
  const b = await store.getAgent(2, 'soporte');
  const s1 = engine.getSession(a);
  s1.variables.secreto = 'de A';
  const s2 = engine.getSession(b, s1.id);
  assert.notEqual(s2.id, s1.id);
  assert.equal(s2.variables.secreto, undefined);
  engine.resetSession(2, s1.id); // otra empresa no puede borrarla
  assert.equal(engine.getSession(a, s1.id).id, s1.id);
});

test('el conocimiento no puede leer archivos fuera del agente', async () => {
  await store.saveAgent(2, { id: 'secreto', name: 'Secreto', instructions: 'x' });
  await writeFile(join(env.agentsDir, '2', 'secreto', 'clave.md'), 'PALABRA-SECRETA-DE-B');
  const malicioso = await store.saveAgent(1, { id: 'malo', name: 'Malo', instructions: 'x', knowledge: [{ type: 'file', path: '../../2/secreto/clave.md' }] });
  const hits = await search(malicioso, store.agentDir(1, 'malo'), 'PALABRA SECRETA');
  assert.deepEqual(hits, []);
});

test('las acciones del agente no ven secretos del servidor', async () => {
  process.env.DEEPSEEK_API_KEY = 'sk-no-debe-salir';
  const { runAction } = await import('../src/actions.ts');
  let seen = '';
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => { seen = String(url); return new Response('{}'); }) as typeof fetch;
  try {
    await runAction({ name: 'x', description: 'x', method: 'GET', url: 'https://example.com/?k={{env.DEEPSEEK_API_KEY}}' }, {}, 1);
  } finally {
    globalThis.fetch = orig;
    delete process.env.DEEPSEEK_API_KEY;
  }
  assert.ok(!seen.includes('sk-no-debe-salir'));
});

test('MCP local (stdio) solo en la empresa Default', async () => {
  const { assertStdioAllowed } = await import('../src/mcp-client.ts');
  assert.throws(() => assertStdioAllowed({ transport: 'stdio', command: 'cat', tenantId: 2 }), /solo están permitidos/);
  assert.doesNotThrow(() => assertStdioAllowed({ transport: 'stdio', command: 'cat', tenantId: 1 }));
});
