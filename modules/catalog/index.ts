// Catálogo de apps generado (npm run build:catalog): cientos de servicios con acciones
// sacadas de su especificación OpenAPI (APIs.guru) y servidores MCP oficiales de marcas
// conocidas. Las apps hechas a mano en modules/apps tienen prioridad sobre estas.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionDef, Argument, ModuleDef, StepContext } from '../../src/modules/sdk.ts';
import { callTool, listTools } from '../../src/mcp-client.ts';

interface Param { n: string; in: 'path' | 'query' | 'header'; r?: boolean; t?: 'string' | 'number' | 'boolean' | 'dropdown'; d?: string; o?: string[] }
interface Op { key: string; name: string; m: string; p: string; params: Param[]; body?: string }
type Auth = { type: 'none' } | { type: 'key'; in: 'header' | 'query'; name: string } | { type: 'bearer' } | { type: 'basic' };
interface CatalogApp {
  key: string; name: string; description: string; category: string; color: string; logo?: string; docs?: string;
  source: 'openapi' | 'mcp'; spec?: string; base?: string; needsBase?: boolean; auth?: Auth; ops?: Op[]; totalOps?: number;
  mcpUrl?: string; mcpTransport?: 'http' | 'sse'; mcpHeaders?: { name: string; secret?: boolean; description?: string }[];
}

const FILE = join(import.meta.dirname, 'apps.json');
const apps: CatalogApp[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).apps : [];

type Field = NonNullable<ModuleDef['auth']>['fields'][number];
const argKey = (p: Param) => `${p.in}_${p.n}`.replace(/[^A-Za-z0-9_]/g, '_');
const parse = (v: unknown) => (typeof v === 'string' ? (v.trim() ? JSON.parse(v) : undefined) : v);

async function creds(app: CatalogApp, fields: Field[], ctx: StepContext): Promise<Record<string, string>> {
  if (!fields.length) return {};
  const c = await ctx.connection(app.key, fields.map((f) => f.key));
  const missing = fields.filter((f) => !f.optional && !c[f.key]);
  if (missing.length) throw new Error(`Falta conectar ${app.name} (${missing.map((f) => f.label).join(', ')}). Ábrelo en el paso "Elegir conexión".`);
  return c;
}

// ---------- apps OpenAPI ----------
function openapiFields(app: CatalogApp): Field[] {
  const a = app.auth ?? { type: 'none' };
  const f: Field[] = [];
  if (a.type === 'key') f.push({ key: 'apiKey', label: `Clave de API (${a.name})`, secret: true, help: `Se envía como ${a.in === 'header' ? 'cabecera' : 'parámetro'} "${a.name}". Consíguela en el panel de desarrolladores de ${app.name}.` });
  if (a.type === 'bearer') f.push({ key: 'token', label: 'Token de acceso', secret: true, help: `Token de API u OAuth de ${app.name}; se envía como "Authorization: Bearer …".` });
  if (a.type === 'basic') f.push({ key: 'username', label: 'Usuario' }, { key: 'password', label: 'Contraseña o clave', secret: true });
  // Muchas especificaciones no declaran su autenticación: estos dos campos permiten añadirla igualmente
  f.push({ key: 'extraHeaders', label: 'Cabeceras extra (JSON, opcional)', secret: true, optional: true, placeholder: '{"X-Api-Key": "…"}', help: 'Para claves que la especificación no declara.' });
  f.push({ key: 'extraQuery', label: 'Parámetros extra en la URL (JSON, opcional)', secret: true, optional: true, placeholder: '{"key": "…"}' });
  f.push({ key: 'baseUrl', label: 'URL base de la API', placeholder: app.base, optional: !app.needsBase, help: app.needsBase ? 'Esta API depende de tu cuenta o servidor: escribe su URL base.' : 'Déjalo vacío para usar la URL por defecto.' });
  return f;
}

async function call(app: CatalogApp, c: Record<string, string>, method: string, path: string, query: Record<string, unknown>, headers: Record<string, string>, body: unknown) {
  const base = (c.baseUrl || app.base || '').replace(/\/$/, '');
  if (!base || /\{[^}]+\}/.test(base)) throw new Error(`Indica la URL base de ${app.name} en la conexión (la de ejemplo es ${app.base}).`);
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const extra = (k: string): Record<string, string> => { try { return c[k] ? JSON.parse(c[k]) : {}; } catch { throw new Error(`"${k === 'extraHeaders' ? 'Cabeceras extra' : 'Parámetros extra'}" de la conexión de ${app.name} no es JSON válido`); } };
  for (const [k, v] of Object.entries(extra('extraQuery'))) url.searchParams.set(k, String(v));
  const h: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'AgentStudio/0.1', ...extra('extraHeaders'), ...headers };
  const a = app.auth ?? { type: 'none' };
  if (a.type === 'key' && c.apiKey) { if (a.in === 'header') h[a.name] = c.apiKey; else url.searchParams.set(a.name, c.apiKey); }
  if (a.type === 'bearer' && c.token) h.Authorization = /^(bearer|token|basic) /i.test(c.token) ? c.token : `Bearer ${c.token}`;
  if (a.type === 'basic' && c.username) h.Authorization = `Basic ${Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64')}`;
  let payload: string | undefined;
  if (body !== undefined && method !== 'GET' && method !== 'DELETE') { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) throw new Error(`${app.name} respondió ${res.status}: ${(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300)}`);
  return { status: res.status, data };
}

function opArgs(op: Op): Argument[] {
  const args: Argument[] = op.params.map((p) => ({
    key: argKey(p),
    label: p.n,
    type: p.t ?? 'string',
    required: Boolean(p.r),
    variables: true,
    ...(p.d ? { description: p.d } : {}),
    ...(p.o ? { options: [...(p.r ? [] : [{ label: '—', value: '' }]), ...p.o.map((o) => ({ label: o, value: o }))] } : {}),
  }) as Argument);
  if (op.body !== undefined) args.push({ key: 'body', label: 'Cuerpo (JSON)', type: 'json', variables: true, default: op.body });
  return args;
}

function openapiModule(app: CatalogApp): ModuleDef {
  const fields = openapiFields(app);
  const actions: ActionDef[] = (app.ops ?? []).map((op) => ({
    key: op.key,
    name: op.name,
    description: `${op.m} ${op.p} · Respuesta en {{steps.<id>.data}}.`,
    arguments: opArgs(op),
    async run(ctx) {
      const c = await creds(app, fields, ctx);
      let path = op.p;
      const query: Record<string, unknown> = {};
      const headers: Record<string, string> = {};
      for (const p of op.params) {
        const v = ctx.args[argKey(p)];
        if (v === undefined || v === null || v === '') { if (p.r) throw new Error(`Falta "${p.n}"`); continue; }
        if (p.in === 'path') path = path.replace(`{${p.n}}`, encodeURIComponent(String(v)));
        else if (p.in === 'query') query[p.n] = v;
        else headers[p.n] = String(v);
      }
      return call(app, c, op.m, path, query, headers, op.body !== undefined ? parse(ctx.args.body) : undefined);
    },
  }));
  // Para llegar a cualquier otro endpoint de la API con la misma conexión
  actions.push({
    key: 'request',
    name: 'Llamar a cualquier endpoint',
    description: `Usa la conexión de ${app.name} con otra ruta de su API${app.totalOps ? ` (tiene ${app.totalOps} operaciones)` : ''}.`,
    arguments: [
      { key: 'method', label: 'Método', type: 'dropdown', default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ label: m, value: m })) },
      { key: 'path', label: 'Ruta', type: 'string', required: true, variables: true, placeholder: app.ops?.[0]?.p ?? '/' },
      { key: 'query', label: 'Parámetros de la URL (JSON)', type: 'json', variables: true },
      { key: 'body', label: 'Cuerpo (JSON)', type: 'json', variables: true },
    ],
    async run(ctx) {
      const c = await creds(app, fields, ctx);
      return call(app, c, String(ctx.args.method || 'GET'), String(ctx.args.path), (parse(ctx.args.query) as Record<string, unknown>) ?? {}, {}, parse(ctx.args.body));
    },
  });
  return {
    key: app.key, name: app.name, description: app.description, category: app.category, color: app.color, logo: app.logo,
    badge: 'API', author: 'APIs.guru', version: '1.0.0', homepage: app.docs,
    auth: { fields, help: app.auth?.type === 'none' ? 'La especificación no declara credenciales; si la API pide una clave, ponla en "Cabeceras extra" o "Parámetros extra".' : `Credenciales de ${app.name}.` },
    actions,
  };
}

// ---------- apps MCP ----------
function mcpFields(app: CatalogApp): Field[] {
  const hs = app.mcpHeaders ?? [];
  if (!hs.length) return [{ key: 'token', label: 'Token (si el servidor lo pide)', secret: true, optional: true, help: 'Muchos servidores MCP usan OAuth en el navegador; si te da un token personal, pégalo aquí. Se envía como "Authorization: Bearer …".' }];
  return hs.map((h) => ({ key: `h_${h.name.replace(/[^A-Za-z0-9]/g, '_')}`, label: h.name, secret: h.secret, optional: /optional|opcional/i.test(h.description ?? ''), help: h.description }));
}

function mcpHeaders(app: CatalogApp, c: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!app.mcpHeaders?.length) { if (c.token) out.Authorization = /^(bearer|basic) /i.test(c.token) ? c.token : `Bearer ${c.token}`; return out; }
  for (const h of app.mcpHeaders) {
    let v = c[`h_${h.name.replace(/[^A-Za-z0-9]/g, '_')}`];
    if (!v) continue;
    if (/^authorization$/i.test(h.name) && !/^(bearer|basic|token) /i.test(v)) v = `Bearer ${v}`;
    out[h.name] = v;
  }
  return out;
}

function mcpModule(app: CatalogApp): ModuleDef {
  const fields = mcpFields(app);
  const cfg = async (ctx: StepContext) => ({ transport: app.mcpTransport ?? 'http', url: app.mcpUrl!, headers: mcpHeaders(app, await creds(app, fields, ctx)) });
  return {
    key: app.key, name: app.name, description: app.description, category: 'MCP', color: app.color, logo: app.logo,
    badge: 'MCP', author: 'Registro MCP', version: '1.0.0', homepage: app.docs,
    auth: { fields, help: `Servidor MCP: ${app.mcpUrl}` },
    actions: [
      {
        key: 'list-tools', name: 'Ver herramientas', description: 'Lista las herramientas del servidor y sus parámetros.',
        arguments: [],
        async run(ctx) {
          const tools = await listTools(await cfg(ctx), false);
          return { total: tools.length, herramientas: tools.map((t) => ({ nombre: t.name, descripcion: t.description, parametros: Object.keys((t.inputSchema?.properties as object) ?? {}) })) };
        },
      },
      {
        key: 'call-tool', name: 'Usar una herramienta', description: 'Resultado en {{steps.<id>.text}}.',
        arguments: [
          { key: 'tool', label: 'Herramienta', type: 'string', required: true, description: 'Nombre exacto; míralo con "Ver herramientas".' },
          { key: 'arguments', label: 'Parámetros (JSON)', type: 'json', variables: true, default: '{}' },
        ],
        async run(ctx) {
          const r = await callTool(await cfg(ctx), String(ctx.args.tool), (parse(ctx.args.arguments) as Record<string, unknown>) ?? {});
          if (r.isError) throw new Error(`La herramienta devolvió un error: ${r.text.slice(0, 300)}`);
          return r;
        },
      },
    ],
  };
}

export default apps.map((a) => (a.source === 'mcp' ? mcpModule(a) : openapiModule(a)));
