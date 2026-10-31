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

// Precios en USD por millón de tokens. Configurables porque cambian con el tiempo:
// revisa la página de precios de tu proveedor y ajústalos en .env.
export const PRICES = {
  input: Number(process.env.PRICE_INPUT_PER_M ?? 0.28),
  cacheHit: Number(process.env.PRICE_CACHE_HIT_PER_M ?? 0.028),
  output: Number(process.env.PRICE_OUTPUT_PER_M ?? 0.42),
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
  latencyMs: { total: number; steps: Record<string, number> };
  error?: string;
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

export type MetricEvent = TurnEvent | TtsEvent;

interface TurnCtx {
  input: number;
  cacheHit: number;
  output: number;
  llmCalls: number;
  // Coste que informa Claude Code (ya calculado con sus precios) y sus tokens,
  // que no se vuelven a cobrar con los precios de DeepSeek
  reportedCostUsd: number;
  reported: { input: number; cacheHit: number; output: number };
  steps: Record<string, number>;
  route?: Route;
}

const als = new AsyncLocalStorage<TurnCtx>();

export function costOf(input: number, cacheHit: number, output: number): number {
  return ((input - cacheHit) * PRICES.input + cacheHit * PRICES.cacheHit + output * PRICES.output) / 1_000_000;
}

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

export function addUsage(u: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | undefined): void {
  const ctx = als.getStore();
  if (!ctx || !u) return;
  ctx.input += u.prompt_tokens ?? 0;
  ctx.cacheHit += u.prompt_cache_hit_tokens ?? 0;
  ctx.output += u.completion_tokens ?? 0;
  ctx.llmCalls++;
}

export function addClaudeUsage(u: { input: number; cacheHit: number; output: number; costUsd: number }): void {
  const ctx = als.getStore();
  if (!ctx) return;
  ctx.reported.input += u.input;
  ctx.reported.cacheHit += u.cacheHit;
  ctx.reported.output += u.output;
  ctx.reportedCostUsd += u.costUsd;
  ctx.llmCalls++;
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
  const ctx: TurnCtx = { input: 0, cacheHit: 0, output: 0, llmCalls: 0, reportedCostUsd: 0, reported: { input: 0, cacheHit: 0, output: 0 }, steps: {} };
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
      tokens: { input: ctx.input + ctx.reported.input, cacheHit: ctx.cacheHit + ctx.reported.cacheHit, output: ctx.output + ctx.reported.output, known: true },
      costUsd: costOf(ctx.input, ctx.cacheHit, ctx.output) + ctx.reportedCostUsd,
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
    else ttsChars += e.chars ?? 0;
  }
  return { conversations: sessions.size, turns, costUsd: Math.round(costUsd * 10000) / 10000, ttsChars };
}
