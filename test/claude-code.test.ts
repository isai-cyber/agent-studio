// Backend Claude Code (Claude Agent SDK) con query() simulado: no llama a la API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupEnv, dbAvailable } from './_helpers.ts';

const hasDb = await dbAvailable();
const env = await setupEnv('claude-code', { db: hasDb });
process.env.AGENT_BACKEND = 'claude-code';
process.env.CLAUDE_CODE_TOOLS = 'WebSearch';
const cc = await import('../src/claude-code.ts');
const store = await import('../src/store.ts');
const { handleTurn } = await import('../src/engine.ts');
const { readEvents } = await import('../src/metrics.ts');
let tenantB = 0;
if (hasDb) {
  const { runMigrations } = await import('../src/db/migrations.ts');
  const { createTenant, listPlans } = await import('../src/tenancy/tenants.ts');
  await runMigrations();
  tenantB = (await createTenant({ name: 'Beta', planId: (await listPlans())[0].id })).id;
}
after(async () => { if (hasDb) await (await import('../src/db/pool.ts')).closeDb(); });

// Simula una sesión de Claude Code: el coste y los tokens llegan acumulados por sesión
const calls: { prompt: string; options: any }[] = [];
const totals = new Map<string, number>();
cc.setQueryImpl(((params: { prompt: string; options: any }) => {
  calls.push(params);
  const sessionId = params.options.resume ?? `s${calls.length}`;
  const turns = (totals.get(sessionId) ?? 0) + 1;
  totals.set(sessionId, turns);
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: sessionId };
    yield {
      type: 'result', subtype: 'success', is_error: false, result: `Respuesta ${turns}`, session_id: sessionId,
      total_cost_usd: 0.01 * turns,
      modelUsage: { 'claude-opus-5-5': { inputTokens: 100 * turns, outputTokens: 20 * turns, cacheReadInputTokens: 50 * turns, cacheCreationInputTokens: 0 } },
    };
  })();
}) as never);

test('responde con Claude Code, continúa la sesión y apunta solo el coste de cada turno', async () => {
  await store.saveAgent(1, { id: 'ventas', name: 'Ventas', instructions: 'Vende zapatos.', knowledge: [{ type: 'text', name: 'Horario', content: 'De 9 a 18 h' }],
    actions: [{ name: 'consultar stock', description: 'Stock de un producto', url: 'https://example.com/stock/{{sku}}', method: 'GET', parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] } }] });
  const agent = await store.getAgent(1, 'ventas');
  const r1 = await handleTurn(agent, undefined, 'hola');
  assert.deepEqual(r1.messages, ['Respuesta 1']);
  const r2 = await handleTurn(agent, r1.sessionId, '¿tenéis el 42?');
  assert.deepEqual(r2.messages, ['Respuesta 2']);

  // CLAUDE.md en el espacio del agente, por empresa
  const md = await readFile(join(env.dataDir, 'tenants', '1', 'claude-code', 'ventas', 'CLAUDE.md'), 'utf8');
  assert.match(md, /Vende zapatos/);
  assert.match(md, /De 9 a 18 h/);
  assert.match(md, /consultar_stock/);

  const [o1, o2] = calls.map((c) => c.options);
  assert.equal(o1.cwd, join(env.dataDir, 'tenants', '1', 'claude-code', 'ventas'));
  assert.equal(o1.resume, undefined);
  assert.equal(o2.resume, 's1', 'el segundo turno continúa la sesión de Claude Code');
  assert.deepEqual(o1.settingSources, ['project']);
  assert.equal(o1.permissionMode, 'dontAsk');
  assert.equal(o1.model, 'claude-opus-5-5');
  assert.deepEqual(o1.tools, ['WebSearch'], 'herramientas integradas solo las permitidas (Default)');
  assert.ok(o1.allowedTools.includes('mcp__agent-studio__consultar_stock'));
  assert.ok(o1.mcpServers['agent-studio']);

  // Métricas: el segundo turno cuesta 0,01 (no el acumulado 0,02)
  const turns = (await readEvents(1)).events.filter((e) => e.type === "turn") as any[];
  assert.equal(turns.length, 2);
  assert.ok(turns.every((t: any) => t.route === 'claude-code' && t.tokens.known));
  assert.ok(Math.abs(turns[1].costUsd - 0.01) < 1e-9);
  assert.equal(turns[1].tokens.output, 20);
  assert.equal(turns[1].tokens.input, 150);
});

test('si cambia el agente se regenera CLAUDE.md y empieza una sesión nueva', async () => {
  const agent = await store.getAgent(1, 'ventas');
  const r = await handleTurn(agent, undefined, 'hola');
  agent.instructions = 'Vende zapatos y bolsos.';
  await store.saveAgent(1, agent);
  calls.length = 0;
  await handleTurn(await store.getAgent(1, 'ventas'), r.sessionId, 'otra');
  assert.equal(calls[0].options.resume, undefined);
  assert.match(await readFile(join(env.dataDir, 'tenants', '1', 'claude-code', 'ventas', 'CLAUDE.md'), 'utf8'), /bolsos/);
});

test('otras empresas: espacio propio, sin herramientas integradas ni MCP por stdio', { skip: !hasDb && 'necesita MariaDB' }, async () => {
  await store.saveAgent(tenantB, { id: 'ventas', name: 'Ventas B', instructions: 'Empresa B.', mcpServers: [{ name: 'local', command: 'cat' }, { name: 'remoto', url: 'https://mcp.example.com/mcp' }] });
  calls.length = 0;
  await handleTurn(await store.getAgent(tenantB, 'ventas'), undefined, 'hola');
  const o = calls[0].options;
  assert.equal(o.cwd, join(env.dataDir, 'tenants', String(tenantB), 'claude-code', 'ventas'));
  assert.deepEqual(o.tools, []);
  assert.ok(!o.mcpServers.local, 'stdio solo en Default');
  assert.equal(o.mcpServers.remoto.type, 'http');
  assert.ok(o.allowedTools.includes('mcp__remoto'));
  assert.ok(existsSync(join(env.dataDir, 'tenants', String(tenantB), 'claude-code', 'ventas', 'CLAUDE.md')));
  assert.doesNotMatch(await readFile(join(env.dataDir, 'tenants', String(tenantB), 'claude-code', 'ventas', 'CLAUDE.md'), 'utf8'), /zapatos/);
});

test('un error de Claude Code se informa', async () => {
  cc.setQueryImpl((() => (async function* () {
    yield { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'x', total_cost_usd: 0, modelUsage: {} };
  })()) as never);
  await assert.rejects(handleTurn(await store.getAgent(1, 'ventas'), undefined, 'hola'), /error_max_turns/);
});
