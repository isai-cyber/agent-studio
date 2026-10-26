// Cliente para DeepSeek (API compatible con OpenAI). También funciona con Ollama,
// vLLM o cualquier endpoint /v1/chat/completions cambiando DEEPSEEK_BASE_URL.
import type { ChatMessage, ToolCall } from './types.ts';
import { timed, addUsage } from './metrics.ts';

const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
export const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface LlmResult {
  content: string | null;
  tool_calls?: ToolCall[];
}

export function llmConfigured(): boolean {
  return Boolean(API_KEY) || !BASE_URL.includes('api.deepseek.com');
}

export async function chat(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; tools?: ToolSpec[]; json?: boolean; step?: string } = {},
): Promise<LlmResult> {
  if (!llmConfigured()) {
    throw new Error('Falta DEEPSEEK_API_KEY en .env');
  }
  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.4,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.json) body.response_format = { type: 'json_object' };

  // El tiempo se apunta al paso del turno (por defecto "llm") para las métricas
  const res = await timed(opts.step ?? 'llm', () => fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  }));
  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = (await res.json()) as { choices: { message: LlmResult }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } };
  addUsage(data.usage);
  const msg = data.choices[0]?.message ?? { content: '' };
  return { content: msg.content ?? null, tool_calls: msg.tool_calls };
}
