// Modo orquestado: Jev decide, Qwen/DeepSeek orquestan y Claude Code hace lo complejo.
// Jev, el LLM y Claude Code se simulan (no se llama a ninguna API).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './_helpers.ts';

await setupEnv('orchestrator');
process.env.AGENT_BACKEND = 'orquestado';
process.env.DEEPSEEK_API_KEY = 'sk-deepseek';
process.env.TYPESAFE_API_KEY = 'ts-key';
const store = await import('../src/store.ts');
const { handleTurn } = await import('../src/engine.ts');
const cc = await import('../src/claude-code.ts');
const { jevAsk } = await import('../src/jev.ts');
const { readEvents } = await import('../src/metrics.ts');

// --- Jev simulado: responde según lo que haya en jevPlan
let jevCalls: any[] = [];
let jevPlan: (body: any) => Record<string, unknown> = () => ({});
// --- LLM simulado (DeepSeek): devuelve lo que diga llmPlan
let llmCalls: any[] = [];
let llmPlan: (body: any, n: number) => any = () => ({ content: 'respuesta del orquestador' });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
  if (u === 'https://api.typesafe.ai/v1/systemone') {
    const body = JSON.parse(String(init?.body));
    jevCalls.push({ body, auth: (init?.headers as Record<string, string>).Authorization });
    return json({ model: 'jev-1.14.0', answers: jevPlan(body), usage: { input_tokens: 1000, output_tokens: 5 } });
  }
  if (u.endsWith('/chat/completions')) {
    const body = JSON.parse(String(init?.body));
    llmCalls.push(body);
    return json({ choices: [{ message: llmPlan(body, llmCalls.length) }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  }
  return realFetch(url, init);
}) as typeof fetch;

// --- Claude Code simulado
let claudeCalls: any[] = [];
cc.setQueryImpl(((params: { prompt: string; options: any }) => {
  claudeCalls.push(params);
  return (async function* () {
    yield { type: 'result', subtype: 'success', is_error: false, result: `Claude Code hizo: ${params.prompt}`, session_id: 'cc1', total_cost_usd: 0.05, modelUsage: {} };
  })();
}) as never);

beforeEach(() => { jevCalls = []; llmCalls = []; claudeCalls = []; llmPlan = () => ({ content: 'respuesta del orquestador' }); });
const route = (decision: string, confidence = 0.9) => (body: any) => ({ decision: { type: 'choice', choice: decision, confidence, probabilities: {} } });

await store.saveAgent(1, { id: 'ventas', name: 'Ventas', instructions: 'Atiende a clientes.' });
const agent = () => store.getAgent(1, 'ventas');

test('el cliente de Jev envía preguntas tipadas y apunta el coste por modelo', async () => {
  jevPlan = () => ({ urgente: { type: 'noul', noul: 0.83 } });
  const a = await jevAsk('Mi pedido no llegó y lo necesito hoy', { urgente: { type: 'noul', instructions: '¿Es urgente?' } }, { tenantId: 1, purpose: 'prueba' });
  assert.equal((a.urgente as any).noul, 0.83);
  assert.equal(jevCalls[0].auth, 'Bearer ts-key');
  assert.equal(jevCalls[0].body.model, 'jev-latest');
  assert.equal(jevCalls[0].body.questions.urgente.type, 'noul');
  await new Promise((r) => setTimeout(r, 100));
  const ev = (await readEvents(1)).events.find((e: any) => e.type === 'llm' && e.models['typesafe:jev-1.14.0']) as any;
  assert.ok(Math.abs(ev.costUsd - 0.000042) < 1e-12); // 1000 tokens × $0,042/M
});

test('lo sencillo lo responde el orquestador (Qwen/DeepSeek) sin tocar Claude Code', async () => {
  jevPlan = route('directa');
  const r = await handleTurn(await agent(), undefined, '¿A qué hora abren?');
  assert.deepEqual(r.messages, ['respuesta del orquestador']);
  assert.equal(claudeCalls.length, 0);
  assert.deepEqual(Object.keys(jevCalls[0].body.questions.decision.criteria), ['directa', 'compleja']);
  // El orquestador tiene la herramienta para delegar
  assert.ok(llmCalls[0].tools.some((t: any) => t.function.name === 'delegar_a_claude_code'));
});

test('lo complejo va directo a Claude Code', async () => {
  jevPlan = route('compleja');
  const r = await handleTurn(await agent(), undefined, 'Analiza estos 3 contratos y compáralos');
  assert.deepEqual(r.messages, ['Claude Code hizo: Analiza estos 3 contratos y compáralos']);
  assert.equal(llmCalls.length, 0);
  // Dentro de Claude Code, Jev y el modelo rápido están disponibles como herramientas
  const allowed = claudeCalls[0].options.allowedTools;
  assert.ok(allowed.includes('mcp__agent-studio__jev_decidir'));
  assert.ok(allowed.includes('mcp__agent-studio__modelo_rapido'));
});

test('si Jev duda, decide el orquestador, que puede delegar en Claude Code', async () => {
  jevPlan = route('compleja', 0.3); // confianza baja: no se actúa sobre ella
  llmPlan = (_b, n) => (n === 1
    ? { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delegar_a_claude_code', arguments: '{"tarea":"calcular la ruta óptima"}' } }] }
    : { content: 'Listo: Claude Code calculó la ruta.' });
  const r = await handleTurn(await agent(), undefined, 'Calcula la ruta de reparto');
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0].prompt, 'calcular la ruta óptima');
  assert.match(llmCalls[1].messages.at(-1).content, /Claude Code hizo: calcular la ruta óptima/);
  assert.deepEqual(r.messages, ['Listo: Claude Code calculó la ruta.']);
  assert.ok(r.sources?.includes('Claude Code'));
});

test('si Claude Code falla, responde el orquestador', async () => {
  jevPlan = route('compleja');
  cc.setQueryImpl((() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'x', total_cost_usd: 0, modelUsage: {} }; })()) as never);
  const r = await handleTurn(await agent(), undefined, 'Algo complejo');
  assert.deepEqual(r.messages, ['respuesta del orquestador']);
});

test('Jev elige el tema guiado (y si duda, no elige ninguno)', async () => {
  await store.saveAgent(1, { id: 'citas', name: 'Citas', instructions: 'x', topics: [
    { name: 'Saludo', triggers: ['hola'], steps: [{ type: 'message', text: 'Bienvenido' }] },
    { name: 'Agendar cita', description: 'Reservar una cita', triggers: ['quiero una cita'], steps: [{ type: 'message', text: '¿Para qué día?' }] },
  ] });
  jevPlan = (body) => (body.questions.decision.instructions.includes('tema') ? { decision: { type: 'choice', choice: 't1', confidence: 0.95, probabilities: {} } } : route('directa')(body));
  const r = await handleTurn(await store.getAgent(1, 'citas'), undefined, 'me gustaría reservar para el martes');
  assert.equal(r.topic, 'Agendar cita');
  assert.deepEqual(r.messages, ['¿Para qué día?']);
  assert.ok(Object.keys(jevCalls[0].body.questions.decision.criteria).includes('ninguno'));
  jevPlan = (body) => (body.questions.decision.instructions.includes('tema') ? { decision: { type: 'choice', choice: 't1', confidence: 0.2, probabilities: {} } } : route('directa')(body));
  const r2 = await handleTurn(await store.getAgent(1, 'citas'), undefined, 'qué tal el clima');
  assert.equal(r2.topic, undefined);
});

test('en los flujos, «Clasificar texto» y «¿Se cumple?» usan Jev', async () => {
  const flows = await import('../src/flows.ts');
  jevPlan = (body) => (body.questions.d.type === 'choice'
    ? { d: { type: 'choice', choice: 'o1', confidence: 0.88, probabilities: {} } }
    : { d: { type: 'noul', noul: 0.91 } });
  const f = await flows.saveFlow(1, { name: 'IA', trigger: { module: 'core', key: 'manual', args: {} }, steps: [
    { id: 'c', module: 'ia', key: 'classify', args: { text: 'Quiero devolver mi pedido', categories: 'ventas, devoluciones, otro' } },
    { id: 'y', module: 'ia', key: 'yes-no', args: { text: 'Estoy furioso', statement: 'El cliente está enfadado', threshold: 0.5 } },
  ] });
  const { loadModules } = await import('../src/modules/registry.ts');
  await loadModules();
  const run = await flows.runFlow(await flows.getFlow(1, f.id), {}, 'manual');
  assert.equal(run.status, 'ok', JSON.stringify(run.steps));
  assert.deepEqual(run.steps[0].output, { category: 'devoluciones', confianza: 0.88, via: 'jev' });
  assert.deepEqual(run.steps[1].output, { cumple: true, probabilidad: 0.91, via: 'jev' });
});
