// Cliente de LLM con varios proveedores compatibles con OpenAI (DeepSeek, Qwen,
// OpenRouter, Groq, Ollama…, ver src/llm-providers.ts), pensado para ahorrar:
//
// - Rutas por tipo de tarea: las respuestas de los agentes usan LLM_MODEL; las
//   clasificaciones (elegir tema, clasificar texto) usan LLM_MODEL_CLASSIFY, que
//   por defecto es "auto" = el modelo con precio más barato que tenga clave; los
//   flujos y el asistente usan LLM_MODEL_FLOWS (por defecto, LLM_MODEL).
// - Cada agente puede fijar el suyo en el YAML: model: qwen:qwen-plus
// - Respaldo: si un proveedor falla (límite de uso, caída, clave rechazada), se
//   prueba el siguiente de LLM_FALLBACKS.
// - Claves: la de la empresa si la conectó (apps «DeepSeek» o «Qwen» del
//   marketplace, cifrada) y si no, la del servidor (.env).
// - Cada llamada apunta tokens y coste por modelo en las métricas.
import type { ChatMessage, ToolCall } from './types.ts';
import { timed, addUsage } from './metrics.ts';
import { getConnection } from './connections.ts';
import { listProviders, parseModel, priceOf, costOf, pricedModels, baseUrlOf, type ModelRef, type ProviderDef } from './llm-providers.ts';

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface LlmResult {
  content: string | null;
  tool_calls?: ToolCall[];
  model?: string; // "proveedor:modelo" que respondió
}

export type Purpose = 'answer' | 'classify' | 'flow';

export interface ChatOptions {
  model?: string; // "proveedor:modelo" (p. ej. el del agente); manda sobre la ruta
  temperature?: number;
  tools?: ToolSpec[];
  json?: boolean;
  step?: string; // paso de las métricas del turno
  tenantId?: number; // para usar la clave de la empresa y apuntar el consumo
  purpose?: Purpose;
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// Ruta por defecto. DEEPSEEK_MODEL (de versiones anteriores) sigue valiendo.
export const defaultModelSpec = () => process.env.LLM_MODEL || (process.env.DEEPSEEK_MODEL ? `deepseek:${process.env.DEEPSEEK_MODEL}` : 'deepseek:deepseek-flash');
const routeSpec = (purpose: Purpose) =>
  purpose === 'classify' ? process.env.LLM_MODEL_CLASSIFY || 'auto' : purpose === 'flow' ? process.env.LLM_MODEL_FLOWS || defaultModelSpec() : defaultModelSpec();
export const DEFAULT_MODEL = defaultModelSpec();

// ---------- claves ----------

// Ollama u otro sin clave solo cuenta si se configuró a propósito
function serverKey(p: ProviderDef): string | null {
  if (process.env[p.envKey]) return process.env[p.envKey]!;
  if (p.keyless && ((p.envBaseUrl && process.env[p.envBaseUrl]) || process.env.LLM_DEFAULT_PROVIDER === p.key || defaultModelSpec().startsWith(`${p.key}:`))) return '';
  // Compatibilidad: DEEPSEEK_BASE_URL apuntando a un servidor local (Ollama, vLLM) sin clave
  if (p.key === 'deepseek' && process.env.DEEPSEEK_BASE_URL && !process.env.DEEPSEEK_BASE_URL.includes('api.deepseek.com')) return '';
  return null;
}

async function keyFor(p: ProviderDef, tenantId?: number): Promise<string | null> {
  if (tenantId && p.app) {
    const own = (await getConnection(tenantId, p.app, ['apiKey'])).apiKey;
    if (own) return own;
  }
  return serverKey(p);
}

export function configuredProviders(): ProviderDef[] {
  return listProviders().filter((p) => serverKey(p) !== null);
}

// ¿Hay algún proveedor con clave? (del servidor o, si se indica, de la empresa)
export async function llmAvailable(tenantId?: number): Promise<boolean> {
  for (const p of listProviders()) if ((await keyFor(p, tenantId)) !== null) return true;
  return false;
}

export function llmConfigured(): boolean {
  return configuredProviders().length > 0;
}

// ---------- elección de modelo ----------

// El modelo con precio más barato entre los que tienen clave (mezcla típica de
// una clasificación: mucha entrada y casi nada de salida)
async function cheapest(tenantId?: number): Promise<ModelRef | null> {
  let best: { ref: ModelRef; score: number } | null = null;
  for (const ref of pricedModels()) {
    if ((await keyFor(ref.provider, tenantId)) === null) continue;
    const p = priceOf(ref)!;
    const score = p.input * 0.8 + p.output * 0.2;
    if (!best || score < best.score) best = { ref, score };
  }
  return best?.ref ?? null;
}

async function candidates(opts: ChatOptions): Promise<ModelRef[]> {
  const out: ModelRef[] = [];
  const push = (r: ModelRef | null) => { if (r && !out.some((x) => x.ref === r.ref)) out.push(r); };
  // Un agente con modelo de Claude es para el backend Claude Code: aquí se ignora
  const own = opts.model && !opts.model.startsWith('claude') ? opts.model : '';
  const spec = own || routeSpec(opts.purpose ?? 'answer');
  push(spec === 'auto' ? await cheapest(opts.tenantId) : parseModel(spec));
  if (spec === 'auto') push(parseModel(defaultModelSpec()));
  for (const f of (process.env.LLM_FALLBACKS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try { push(parseModel(f)); } catch (err) { console.warn(`[llm] LLM_FALLBACKS: ${(err as Error).message}`); }
  }
  return out;
}

// ---------- llamada ----------

interface OpenAiUsage { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }

async function call(ref: ModelRef, key: string, messages: ChatMessage[], opts: ChatOptions): Promise<LlmResult> {
  const body: Record<string, unknown> = { model: ref.model, messages, temperature: opts.temperature ?? 0.4 };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.json) body.response_format = { type: 'json_object' };
  const res = await fetch(`${baseUrlOf(ref.provider)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 120_000)),
  });
  if (!res.ok) throw fail(res.status, `${ref.provider.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices: { message: LlmResult }[]; usage?: OpenAiUsage };
  const u = data.usage ?? {};
  const input = u.prompt_tokens ?? 0;
  const cacheHit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  addUsage(ref.ref, { input, cacheHit, output, costUsd: costOf(priceOf(ref), input, cacheHit, output) }, opts.tenantId ? { tenantId: opts.tenantId, purpose: opts.purpose ?? 'answer' } : undefined);
  const msg = data.choices?.[0]?.message ?? { content: '' };
  return { content: msg.content ?? null, tool_calls: msg.tool_calls, model: ref.ref };
}

// Se pasa al siguiente proveedor si el error no es culpa de la petición
const retryable = (err: unknown) => {
  const status = (err as { status?: number }).status;
  return status === undefined || status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
};

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<LlmResult> {
  const list = await candidates(opts);
  const errors: string[] = [];
  for (const ref of list) {
    const key = await keyFor(ref.provider, opts.tenantId);
    if (key === null) { errors.push(`${ref.provider.name}: sin clave`); continue; }
    try {
      // El tiempo se apunta al paso del turno (por defecto "llm") para las métricas
      return await timed(opts.step ?? 'llm', () => call(ref, key, messages, opts));
    } catch (err) {
      errors.push((err as Error).message);
      if (!retryable(err)) throw err;
      console.warn(`[llm] ${ref.ref} falló, pruebo el siguiente: ${(err as Error).message}`);
    }
  }
  if (errors.every((e) => e.endsWith('sin clave'))) throw fail(503, `No hay ningún modelo configurado: define la clave de un proveedor en .env (p. ej. DEEPSEEK_API_KEY o QWEN_API_KEY) o conecta DeepSeek o Qwen en Apps.`);
  throw fail(502, `Ningún proveedor de LLM respondió: ${errors.join(' · ')}`);
}

// Resumen para /api/status y la pantalla de métricas
export function llmStatus() {
  return {
    default: defaultModelSpec(),
    classify: routeSpec('classify'),
    flows: routeSpec('flow'),
    fallbacks: (process.env.LLM_FALLBACKS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    providers: listProviders().map((p) => ({ key: p.key, name: p.name, configured: serverKey(p) !== null, app: p.app ?? null, models: Object.keys(p.models) })),
  };
}
