// Módulo OpenAPI: llama a cualquier API que publique una especificación OpenAPI 3
// (o Swagger 2) indicando el operationId. Hay miles en apis.guru.
import YAML from 'yaml';
import type { ModuleDef } from '../../src/modules/sdk.ts';

const specCache = new Map<string, { at: number; spec: any }>();

async function loadSpec(url: string): Promise<any> {
  const hit = specCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.spec;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`No se pudo descargar la especificación (${res.status})`);
  const text = await res.text();
  let spec: any;
  try { spec = JSON.parse(text); } catch { spec = YAML.parse(text); }
  specCache.set(url, { at: Date.now(), spec });
  return spec;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function operations(spec: any) {
  const out: { id: string; method: string; path: string; summary: string; params: any[]; hasBody: boolean }[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      out.push({
        id: op.operationId ?? `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        path,
        summary: op.summary ?? op.description?.slice(0, 120) ?? '',
        params: [...(item.parameters ?? []), ...(op.parameters ?? [])],
        hasBody: Boolean(op.requestBody) || (op.parameters ?? []).some((p: any) => p.in === 'body'),
      });
    }
  }
  return out;
}

function baseUrl(spec: any, specUrl: string, override?: string): string {
  if (override) return override.replace(/\/$/, '');
  if (spec.servers?.[0]?.url) return new URL(spec.servers[0].url, specUrl).href.replace(/\/$/, '');
  if (spec.host) return `${(spec.schemes?.[0] ?? 'https')}://${spec.host}${spec.basePath ?? ''}`.replace(/\/$/, '');
  return new URL(specUrl).origin;
}

const parse = (v: unknown) => (typeof v === 'string' ? (v.trim() ? JSON.parse(v) : {}) : (v ?? {}));

export default {
  key: 'openapi',
  name: 'Cualquier API (OpenAPI)',
  description: 'Llama a cualquier operación de una API con especificación OpenAPI/Swagger. Miles de APIs en apis.guru.',
  icon: '🧾',
  color: '#6BA539',
  category: 'Conectores universales',
  author: 'Agent Studio',
  version: '1.0.0',
  homepage: 'https://apis.guru',
  actions: [
    {
      key: 'list-operations', name: 'Ver operaciones de la API',
      arguments: [{ key: 'specUrl', label: 'URL de la especificación (JSON o YAML)', type: 'string', required: true, placeholder: 'https://petstore3.swagger.io/api/v3/openapi.json' }],
      async run(ctx) {
        const spec = await loadSpec(String(ctx.args.specUrl));
        const ops = operations(spec);
        return { api: spec.info?.title, version: spec.info?.version, base: baseUrl(spec, String(ctx.args.specUrl)), total: ops.length, operaciones: ops.map((o) => ({ id: o.id, metodo: o.method, ruta: o.path, resumen: o.summary })) };
      },
    },
    {
      key: 'call', name: 'Llamar operación', description: 'Respuesta en {{steps.<id>.data}}.',
      arguments: [
        { key: 'specUrl', label: 'URL de la especificación', type: 'string', required: true },
        { key: 'operationId', label: 'operationId', type: 'string', required: true, placeholder: 'getInventory' },
        { key: 'params', label: 'Parámetros de ruta y query (JSON)', type: 'json', variables: true, default: '{}' },
        { key: 'body', label: 'Cuerpo (JSON, opcional)', type: 'json', variables: true },
        { key: 'headers', label: 'Cabeceras (JSON, p. ej. autenticación)', type: 'json', variables: true, placeholder: '{ "Authorization": "Bearer {{env.FLOW_API_TOKEN}}" }' },
        { key: 'baseUrl', label: 'URL base (opcional, si la especificación no la trae)', type: 'string' },
      ],
      async run(ctx) {
        const spec = await loadSpec(String(ctx.args.specUrl));
        const op = operations(spec).find((o) => o.id === ctx.args.operationId);
        if (!op) throw new Error(`No existe la operación "${ctx.args.operationId}". Usa "Ver operaciones de la API".`);
        const params = parse(ctx.args.params) as Record<string, unknown>;
        let path = op.path;
        const url = new URL(baseUrl(spec, String(ctx.args.specUrl), ctx.args.baseUrl ? String(ctx.args.baseUrl) : undefined) + path);
        for (const p of op.params) {
          const v = params[p.name];
          if (v === undefined) { if (p.required && p.in === 'path') throw new Error(`Falta el parámetro "${p.name}"`); continue; }
          if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
          if (p.in === 'query') url.searchParams.set(p.name, String(v));
        }
        url.pathname = new URL(baseUrl(spec, String(ctx.args.specUrl), ctx.args.baseUrl ? String(ctx.args.baseUrl) : undefined) + path).pathname;
        const body = ctx.args.body ? parse(ctx.args.body) : undefined;
        const res = await fetch(url, {
          method: op.method,
          headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(parse(ctx.args.headers) as Record<string, string>) },
          body: body !== undefined && op.method !== 'GET' ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(25_000),
        });
        const text = await res.text();
        let data: unknown = text;
        try { data = JSON.parse(text); } catch {}
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        return { status: res.status, data };
      },
    },
  ],
} satisfies ModuleDef;
