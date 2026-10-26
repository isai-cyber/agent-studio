// Acciones = llamadas HTTP que el agente puede ejecutar (equivalen a los
// conectores / flujos de Power Automate). Se exponen al LLM como herramientas.
import type { ActionDef } from './types.ts';
import type { ToolSpec } from './llm.ts';

export function toolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function actionTools(actions: ActionDef[] = []): ToolSpec[] {
  return actions.map((a) => ({
    type: 'function',
    function: {
      name: toolName(a.name),
      description: a.description,
      parameters: a.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

// {{env.X}} solo da acceso a variables FLOW_* del .env y solo en la empresa Default:
// los secretos del servidor (DEEPSEEK_API_KEY, DB_PASSWORD...) nunca llegan a un agente.
function envValue(name: string, tenantId: number): string {
  return tenantId === 1 && name.startsWith('FLOW_') ? (process.env[name] ?? '') : '';
}

function fill(template: string, args: Record<string, unknown>, encode: boolean, tenantId: number): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key.startsWith('env.')) return envValue(key.slice(4), tenantId);
    const v = args[key];
    if (v === undefined || v === null) return '';
    return encode ? encodeURIComponent(String(v)) : String(v);
  });
}

export async function runAction(action: ActionDef, args: Record<string, unknown>, tenantId: number): Promise<string> {
  const method = action.method ?? 'POST';
  const usedInUrl = new Set([...action.url.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => m[1]));
  const url = new URL(fill(action.url, args, true, tenantId));
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !usedInUrl.has(k)));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(action.headers ?? {})) headers[k] = fill(v, args, false, tenantId);

  let body: string | undefined;
  if (method === 'GET' || method === 'DELETE') {
    for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, String(v));
  } else {
    headers['Content-Type'] ??= 'application/json';
    body = JSON.stringify(rest);
  }

  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    // 12 000 caracteres: suficiente para usar la respuesta en un tema (saveAs) sin saturar al modelo
    return JSON.stringify({ status: res.status, body: text.slice(0, 12000) });
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}
