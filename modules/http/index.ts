// Petición HTTP a cualquier API.
import type { ModuleDef } from '../../src/modules/sdk.ts';

const parseJson = (v: unknown) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { throw new Error('El campo debe ser JSON válido'); }
};

export default {
  key: 'http',
  name: 'HTTP',
  description: 'Llama a cualquier API REST.',
  icon: '🌐',
  color: '#22d3ee',
  category: 'Desarrollo',
  author: 'CrawStudio A.I',
  version: '1.0.0',
  actions: [
    {
      key: 'request', name: 'Petición HTTP', description: 'GET, POST, PUT, PATCH o DELETE con cabeceras y cuerpo JSON.',
      arguments: [
        { key: 'method', label: 'Método', type: 'dropdown', required: true, default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ label: m, value: m })) },
        { key: 'url', label: 'URL', type: 'string', required: true, variables: true, placeholder: 'https://api.ejemplo.com/recurso' },
        { key: 'headers', label: 'Cabeceras (JSON)', type: 'json', variables: true, placeholder: '{ "Authorization": "Bearer {{env.FLOW_MI_TOKEN}}" }' },
        { key: 'body', label: 'Cuerpo (JSON)', type: 'json', variables: true },
      ],
      async run(ctx) {
        const method = String(ctx.args.method || 'GET');
        const headers = (parseJson(ctx.args.headers) ?? {}) as Record<string, string>;
        const body = parseJson(ctx.args.body);
        const res = await fetch(String(ctx.args.url), {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        let data: unknown = text;
        try { data = JSON.parse(text); } catch {}
        return { status: res.status, ok: res.ok, data };
      },
    },
  ],
} satisfies ModuleDef;
