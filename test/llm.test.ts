// Varios proveedores de LLM (DeepSeek, Qwen…): rutas por tarea, el modelo más barato
// para clasificar, respaldo si un proveedor falla, claves de la plataforma y coste por modelo.
// Las llamadas a los proveedores se simulan con un fetch falso.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupEnv } from './_helpers.ts';

const env = await setupEnv('llm');
process.env.DEEPSEEK_API_KEY = 'sk-deepseek-servidor';
process.env.QWEN_API_KEY = 'sk-qwen-servidor';
process.env.LLM_MODEL = 'qwen:qwen-plus';
const { chat, llmAvailable } = await import('../src/llm.ts');
const { parseModel, priceOf } = await import('../src/llm-providers.ts');
const { runTurn, readEvents } = await import('../src/metrics.ts');
const { updatePlatformSettings, maskedSettings } = await import('../src/platform-settings.ts');

interface Call { url: string; key: string; model: string }
let calls: Call[] = [];
let failWith: Record<string, number> = {}; // host → código de error simulado
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (!u.endsWith('/chat/completions')) return realFetch(url, init);
  const body = JSON.parse(String(init?.body));
  calls.push({ url: u, key: String((init?.headers as Record<string, string>).Authorization ?? '').replace('Bearer ', ''), model: body.model });
  const host = new URL(u).host;
  if (failWith[host]) return new Response('{"error":"límite"}', { status: failWith[host] });
  return new Response(JSON.stringify({ choices: [{ message: { content: `ok de ${body.model}` } }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } } }), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

beforeEach(() => { calls = []; failWith = {}; delete process.env.LLM_FALLBACKS; delete process.env.LLM_MODEL_CLASSIFY; });
const msg = [{ role: 'user' as const, content: 'hola' }];

test('nombres de modelo: proveedor:modelo, solo modelo o por defecto', () => {
  assert.equal(parseModel('qwen:qwen-max').ref, 'qwen:qwen-max');
  assert.equal(parseModel('qwen-flash').ref, 'qwen:qwen-flash');
  assert.equal(parseModel('deepseek-v4-pro').ref, 'deepseek:deepseek-v4-pro');
  assert.equal(parseModel('').ref, 'deepseek:deepseek-flash');
  assert.ok(priceOf(parseModel('qwen:qwen-flash'))!.input < priceOf(parseModel('deepseek:deepseek-flash'))!.input);
  assert.equal(priceOf(parseModel('groq:llama-3.3-70b-versatile')), null);
});

test('las respuestas usan LLM_MODEL y el agente puede fijar el suyo', async () => {
  assert.equal((await chat(msg)).model, 'qwen:qwen-plus');
  assert.match(calls[0].url, /dashscope-intl\.aliyuncs\.com\/compatible-mode\/v1/);
  assert.equal((await chat(msg, { model: 'deepseek:deepseek-v4-pro' })).model, 'deepseek:deepseek-v4-pro');
  assert.match(calls[1].url, /api\.deepseek\.com/);
  // Un modelo de Claude es para el backend Claude Code: aquí se ignora
  assert.equal((await chat(msg, { model: 'claude-opus-5-5' })).model, 'qwen:qwen-plus');
});

test('clasificar usa el modelo más barato con clave (auto)', async () => {
  assert.equal((await chat(msg, { purpose: 'classify' })).model, 'qwen:qwen-flash');
  process.env.LLM_MODEL_CLASSIFY = 'deepseek:deepseek-flash';
  assert.equal((await chat(msg, { purpose: 'classify' })).model, 'deepseek:deepseek-flash');
});

test('si un proveedor falla (429, 5xx) se usa el de respaldo; un 400 no se reintenta', async () => {
  process.env.LLM_FALLBACKS = 'deepseek:deepseek-flash';
  failWith['dashscope-intl.aliyuncs.com'] = 429;
  assert.equal((await chat(msg)).model, 'deepseek:deepseek-flash');
  assert.deepEqual(calls.map((c) => c.model), ['qwen-plus', 'deepseek-flash']);
  calls = [];
  failWith['dashscope-intl.aliyuncs.com'] = 400;
  await assert.rejects(chat(msg), /Qwen \(Alibaba Cloud\) 400/);
  assert.equal(calls.length, 1);
  failWith['api.deepseek.com'] = 503;
  failWith['dashscope-intl.aliyuncs.com'] = 500;
  await assert.rejects(chat(msg), /Ningún proveedor de LLM respondió/);
});

test('todas las empresas usan la clave de la plataforma; la de Ajustes manda sobre el .env', async () => {
  await chat(msg, { tenantId: 2 });
  assert.equal(calls[0].key, 'sk-qwen-servidor');
  updatePlatformSettings({ llmKeys: { qwen: 'sk-qwen-de-ajustes' } });
  await chat(msg, { tenantId: 2 });
  await chat(msg, { tenantId: 3 });
  assert.equal(calls[1].key, 'sk-qwen-de-ajustes');
  assert.equal(calls[2].key, 'sk-qwen-de-ajustes');
  // Lo guardado no contiene la clave en claro y la interfaz la ve enmascarada
  assert.ok(!readFileSync(join(env.dataDir, 'platform', 'settings.json'), 'utf8').includes('sk-qwen-de-ajustes'));
  assert.equal(maskedSettings().llmKeys.qwen, '••••stes');
  updatePlatformSettings({ llmKeys: { qwen: null } });
  await chat(msg);
  assert.equal(calls[3].key, 'sk-qwen-servidor');
});

test('los modelos por tarea de Ajustes mandan sobre el .env', async () => {
  updatePlatformSettings({ llm: { model: 'deepseek:deepseek-v4-pro', classify: 'deepseek:deepseek-flash', fallbacks: ['qwen:qwen-plus'] } });
  try {
    assert.equal((await chat(msg)).model, 'deepseek:deepseek-v4-pro');
    assert.equal((await chat(msg, { purpose: 'classify' })).model, 'deepseek:deepseek-flash');
    assert.throws(() => updatePlatformSettings({ llm: { model: 'no vale' } }), /Modelo no válido/);
  } finally {
    updatePlatformSettings({ llm: { model: '', classify: '', flows: '', fallbacks: [] } });
  }
});

test('sin claves de la plataforma no hay servicio de IA', async () => {
  const saved = { d: process.env.DEEPSEEK_API_KEY, q: process.env.QWEN_API_KEY };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.QWEN_API_KEY;
  try {
    assert.equal(await llmAvailable(3), false);
    await assert.rejects(chat(msg, { tenantId: 3 }), /servicio de IA no está configurado/);
  } finally {
    process.env.DEEPSEEK_API_KEY = saved.d;
    process.env.QWEN_API_KEY = saved.q;
  }
});

test('las métricas guardan tokens y coste por modelo, también fuera de una conversación', async () => {
  await runTurn({ tenantId: 1, agentId: 'a', channel: 'ui' }, async () => {
    await chat(msg, { tenantId: 1, purpose: 'classify' });
    await chat(msg, { tenantId: 1 });
    return { sessionId: 's1' };
  });
  await chat(msg, { tenantId: 1, purpose: 'flow' }); // p. ej. un paso «Generar texto» de un flujo
  await new Promise((r) => setTimeout(r, 100)); // las métricas se escriben sin bloquear la respuesta
  const events = (await readEvents(1)).events;
  const turn = events.find((e) => e.type === 'turn') as any;
  assert.deepEqual(Object.keys(turn.models).sort(), ['qwen:qwen-flash', 'qwen:qwen-plus']);
  // qwen-plus: 600 × 0,4 + 400 × 0,4 + 100 × 1,2 por millón = 0,00052 USD
  assert.ok(Math.abs(turn.models['qwen:qwen-plus'].costUsd - 0.00052) < 1e-9);
  assert.ok(Math.abs(turn.costUsd - (0.00052 + 0.00009)) < 1e-9);
  assert.equal(turn.tokens.cacheHit, 800);
  const outside = events.find((e) => e.type === 'llm') as any;
  assert.equal(outside.purpose, 'flow');
  assert.ok(outside.models['qwen:qwen-plus']);
});
