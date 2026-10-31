// Jev (TypeSafe AI): modelo "System One" para decisiones estructuradas, muy rápido
// (70–500 ms) y barato ($0,042 por millón de tokens de entrada; la salida es gratis).
// No genera texto: recibe un estado y preguntas tipadas y devuelve, en paralelo y
// en una sola llamada:
//   choice → una opción de una lista (con probabilidades y confianza)
//   score  → un nivel de una escala (con probabilidades y confianza)
//   noul   → probabilidad (0–1) de que una afirmación sea cierta
// Aquí se usa para las muchas decisiones baratas: elegir el tema, decidir si un
// mensaje necesita Claude Code, clasificar en los flujos… Lo que Jev no puede
// hacer (redactar) lo hacen Qwen o DeepSeek, y lo complejo, Claude Code.
//
// Documentación: https://docs.typesafe.ai (POST https://api.typesafe.ai/v1/systemone)
import { getPlatformSettings } from './platform-settings.ts';
import { addUsage, timed } from './metrics.ts';

export const JEV_MODEL = () => process.env.JEV_MODEL || 'jev-latest';
const BASE_URL = () => (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');
// Precio oficial (docs.typesafe.ai/models, consultado el 31/10/2026): $0,042 por Mtok de entrada
const PRICE_INPUT_PER_M = () => Number(process.env.JEV_PRICE_INPUT_PER_M ?? 0.042);
// Por debajo de esta confianza no se actúa sobre una elección de Jev
export const JEV_MIN_CONFIDENCE = () => Number(process.env.JEV_MIN_CONFIDENCE ?? 0.6);

export type JevQuestion =
  | { type: 'choice'; criteria: Record<string, string>; instructions?: string }
  | { type: 'score'; criteria: string[]; instructions?: string }
  | { type: 'noul'; instructions?: string; criteria?: { true: string; false: string } };

export type JevAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number };

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export function jevKey(): string | null {
  return getPlatformSettings().llmKeys.typesafe || process.env.TYPESAFE_API_KEY || null;
}

export function jevConfigured(): boolean {
  return Boolean(jevKey());
}

// Una llamada con varias preguntas sobre el mismo estado (se responden en paralelo)
export async function jevAsk(state: unknown, questions: Record<string, JevQuestion>, opts: { tenantId?: number; purpose?: string } = {}): Promise<Record<string, JevAnswer>> {
  const key = jevKey();
  if (!key) throw fail(503, 'Jev no está configurado: pon la clave de TypeSafe en Empresas y planes → Ajustes.');
  const res = await timed('jev', () => fetch(`${BASE_URL()}/v1/systemone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL(), state, questions }),
    signal: AbortSignal.timeout(Number(process.env.JEV_TIMEOUT_MS ?? 15_000)),
  }));
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw fail(res.status === 400 || res.status === 422 ? 400 : 502, `Jev respondió ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as { model: string; answers: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
  const input = data.usage?.input_tokens ?? 0;
  const output = data.usage?.output_tokens ?? 0;
  addUsage(`typesafe:${data.model || JEV_MODEL()}`, { input, cacheHit: 0, output, costUsd: (input * PRICE_INPUT_PER_M()) / 1_000_000 }, opts.tenantId ? { tenantId: opts.tenantId, purpose: opts.purpose ?? 'jev' } : undefined);
  return data.answers ?? {};
}

// Atajo: elegir una opción. Devuelve null si Jev duda (confianza baja).
export async function jevChoose(state: unknown, options: Record<string, string>, instructions: string, opts: { tenantId?: number; purpose?: string; minConfidence?: number } = {}): Promise<{ choice: string; confidence: number } | null> {
  const a = (await jevAsk(state, { decision: { type: 'choice', criteria: options, instructions } }, opts)).decision;
  if (a?.type !== 'choice' || !(a.choice in options)) return null;
  return a.confidence >= (opts.minConfidence ?? JEV_MIN_CONFIDENCE()) ? { choice: a.choice, confidence: a.confidence } : null;
}

// Prueba la clave (lista los modelos; no gasta tokens)
export async function testJev(): Promise<{ ok: boolean; message: string }> {
  const key = jevKey();
  if (!key) return { ok: false, message: 'Sin clave' };
  try {
    const res = await fetch(`${BASE_URL()}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? { ok: true, message: 'TypeSafe (Jev) responde correctamente' } : { ok: false, message: `TypeSafe respondió ${res.status}${res.status === 401 || res.status === 403 ? ' (clave rechazada)' : ''}` };
  } catch (err) {
    return { ok: false, message: `TypeSafe no responde: ${(err as Error).message}` };
  }
}
