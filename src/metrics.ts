// Métricas por mensaje: tokens, coste, latencia por paso y ruta (tema, respuesta
// libre, Claude Code...). Cada turno se guarda como una línea JSON en
// data/tenants/<id>/metrics/events.jsonl. Los datos de ejemplo van aparte, en demo.jsonl.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tenantDataPath } from './tenancy/paths.ts';

const dir = (tenantId: number) => tenantDataPath(tenantId, 'metrics');
const eventsFile = (tenantId: number) => tenantDataPath(tenantId, 'metrics', 'events.jsonl');
const demoFile = (tenantId: number) => tenantDataPath(tenantId, 'metrics', 'demo.jsonl');

// Los precios de los modelos van por proveedor y modelo en src/llm-providers.ts.
// Aquí quedan la voz y el presupuesto mensual.
export const PRICES = {
  ttsPer1kChars: Number(process.env.PRICE_TTS_PER_1K_CHARS ?? 0),
  monthlyBudget: Number(process.env.MONTHLY_BUDGET_USD ?? 20),
};

// 'nanoclaw' solo aparece en métricas antiguas (backend retirado)
export type Route = 'saludo' | 'tema' | 'generativa' | 'claude-code' | 'nanoclaw';
export type Channel = 'ui' | 'api' | 'openai' | 'mcp';

export interface TurnEvent {
  type: 'turn';
  ts: string;
  agentId: string;
  sessionId: string;
  channel: Channel;
  route: Route;
  topic?: string;
  tokens: { input: number; cacheHit: number; output: number; known: boolean };
  costUsd: number;
  // Desglose por modelo ("proveedor:modelo"): cuántas llamadas, tokens y coste
  models?: Record<string, ModelUse>;
  latencyMs: { total: number; steps: Record<string, number> };
  error?: string;
  demo?: boolean;
}

export interface ModelUse { calls: number; input: number; cacheHit: number; output: number; costUsd: number }

// Llamadas al LLM fuera de una conversación (flujos, asistente de automatización)
export interface LlmEvent {
  type: 'llm';
  ts: string;
  purpose: string;
  tokens: { input: number; cacheHit: number; output: number; known: boolean };
  costUsd: number;
  models: Record<string, ModelUse>;
  demo?: boolean;
}

export interface TtsEvent {
  type: 'tts';
  ts: string;
  agentId?: string;
  chars: number;
  latencyMs: number;
  costUsd: number;
  demo?: boolean;
}

export type MetricEvent = TurnEvent | TtsEvent | LlmEvent;

interface TurnCtx {
  input: number;
  cacheHit: number;
  output: number;
  llmCalls: number;
  costUsd: number;
  models: Record<string, ModelUse>;
  steps: Record<string, number>;
  route?: Route;
}

const als = new AsyncLocalStorage<TurnCtx>();

// Mide un paso del turno en curso (no hace nada fuera de un turno)
export async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const ctx = als.getStore();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    if (ctx) ctx.steps[step] = (ctx.steps[step] ?? 0) + (performance.now() - start);
  }
}

export interface Usage { input: number; cacheHit: number; output: number; costUsd: number }

function addTo(models: Record<string, ModelUse>, model: string, u: Usage): void {
  const m = (models[model] ??= { calls: 0, input: 0, cacheHit: 0, output: 0, costUsd: 0 });
  m.calls++;
  m.input += u.input;
  m.cacheHit += u.cacheHit;
  m.output += u.output;
  m.costUsd += u.costUsd;
}

// Apunta una llamada al LLM. Dentro de una conversación suma al turno; fuera
// (flujos, asistente) se guarda como evento 'llm' de la empresa si se indica.
export function addUsage(model: string, u: Usage, outside?: { tenantId: number; purpose: string }): void {
  const ctx = als.getStore();
  if (ctx) {
    ctx.input += u.input;
    ctx.cacheHit += u.cacheHit;
    ctx.output += u.output;
    ctx.costUsd += u.costUsd;
    ctx.llmCalls++;
    addTo(ctx.models, model, u);
    return;
  }
  if (!outside) return;
  const models: Record<string, ModelUse> = {};
  addTo(models, model, u);
  append(outside.tenantId, { type: 'llm', ts: new Date().toISOString(), purpose: outside.purpose, tokens: { input: u.input, cacheHit: u.cacheHit, output: u.output, known: true }, costUsd: u.costUsd, models })
    .catch((e) => console.warn('[metrics]', e.message));
}

export function setRoute(route: Route): void {
  const ctx = als.getStore();
  if (ctx && (!ctx.route || route === 'claude-code' || (route === 'generativa' && ctx.route === 'saludo'))) ctx.route = route;
}

async function append(tenantId: number, event: MetricEvent): Promise<void> {
  await mkdir(dir(tenantId), { recursive: true });
  await appendFile(eventsFile(tenantId), `${JSON.stringify(event)}\n`, 'utf8');
}

// Ejecuta un turno midiendo todo lo que pasa dentro y lo registra al terminar
export async function runTurn<T extends { sessionId: string; topic?: string }>(
  meta: { tenantId: number; agentId: string; channel: Channel },
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: TurnCtx = { input: 0, cacheHit: 0, output: 0, llmCalls: 0, costUsd: 0, models: {}, steps: {} };
  const start = performance.now();
  let result: T | undefined;
  let error: string | undefined;
  try {
    result = await als.run(ctx, fn);
    return result;
  } catch (err) {
    error = (err as Error).message;
    throw err;
  } finally {
    const steps = Object.fromEntries(Object.entries(ctx.steps).map(([k, v]) => [k, Math.round(v)]));
    const event: TurnEvent = {
      type: 'turn',
      ts: new Date().toISOString(),
      agentId: meta.agentId,
      sessionId: result?.sessionId ?? 'error',
      channel: meta.channel,
      route: ctx.route ?? 'tema',
      ...(result?.topic ? { topic: result.topic } : {}),
      tokens: { input: ctx.input, cacheHit: ctx.cacheHit, output: ctx.output, known: true },
      costUsd: ctx.costUsd,
      ...(Object.keys(ctx.models).length ? { models: ctx.models } : {}),
      latencyMs: { total: Math.round(performance.now() - start), steps },
      ...(error ? { error } : {}),
    };
    append(meta.tenantId, event).catch((e) => console.warn('[metrics]', e.message));
  }
}

export async function recordTts(tenantId: number, agentId: string | undefined, chars: number, latencyMs: number): Promise<void> {
  await append(tenantId, {
    type: 'tts',
    ts: new Date().toISOString(),
    ...(agentId ? { agentId } : {}),
    chars,
    latencyMs: Math.round(latencyMs),
    costUsd: (chars / 1000) * PRICES.ttsPer1kChars,
  }).catch((e) => console.warn('[metrics]', e.message));
}

// ---------- lectura ----------

async function readJsonl(file: string): Promise<MetricEvent[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as MetricEvent];
      } catch {
        return [];
      }
    });
}

export async function readEvents(tenantId: number): Promise<{ events: MetricEvent[]; demo: boolean }> {
  const real = await readJsonl(eventsFile(tenantId));
  const demo = await readJsonl(demoFile(tenantId));
  return { events: [...real, ...demo.map((e) => ({ ...e, demo: true }))], demo: demo.length > 0 };
}

export async function clearDemo(tenantId: number): Promise<void> {
  await rm(demoFile(tenantId), { force: true });
}

export async function writeDemo(tenantId: number, events: MetricEvent[]): Promise<void> {
  await mkdir(dir(tenantId), { recursive: true });
  await writeFile(demoFile(tenantId), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

// Consumo de una empresa desde una fecha (para el superadmin y los límites del plan).
// Una conversación = una sesión distinta con al menos un turno.
export async function usageSince(tenantId: number, since: Date): Promise<{ conversations: number; turns: number; costUsd: number; ttsChars: number }> {
  const from = since.toISOString();
  const sessions = new Set<string>();
  let turns = 0, costUsd = 0, ttsChars = 0;
  for (const e of await readJsonl(eventsFile(tenantId))) {
    if (e.ts < from) continue;
    costUsd += e.costUsd ?? 0;
    if (e.type === 'turn') { turns++; if (e.sessionId && e.sessionId !== 'error') sessions.add(e.sessionId); }
    else if (e.type === 'tts') ttsChars += e.chars ?? 0;
  }
  return { conversations: sessions.size, turns, costUsd: Math.round(costUsd * 10000) / 10000, ttsChars };
}
