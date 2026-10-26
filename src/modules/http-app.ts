// Constructor de conectores HTTP declarativos: una app se describe con su
// autenticación, acciones (petición + cuerpo) y disparadores de sondeo, y se
// convierte en un módulo normal. Así añadir una app nueva son unas pocas líneas.
import type { Argument, ModuleDef, StepContext } from './sdk.ts';

export interface AuthField { key: string; label: string; secret?: boolean; placeholder?: string; help?: string; optional?: boolean }

type A = Record<string, any>; // argumentos del paso
type C = Record<string, string>; // credenciales de la conexión

export interface HttpAction {
  key: string;
  name: string;
  description?: string;
  args?: Argument[];
  method?: string;
  url: string | ((a: A, c: C) => string);
  query?: (a: A, c: C) => Record<string, unknown>;
  headers?: (a: A, c: C) => Record<string, string>;
  body?: (a: A, c: C) => unknown;
  encoding?: 'json' | 'form' | 'text';
  pick?: (data: any, a: A) => unknown; // da forma a la respuesta
  check?: (data: any) => string | undefined; // mensaje de error si la API responde 200 con error
  run?: (ctx: StepContext, c: C) => Promise<unknown>; // para casos que no encajan en una petición
}

export interface HttpTrigger {
  key: string;
  name: string;
  description?: string;
  args?: Argument[];
  method?: string;
  url: string | ((a: A, c: C) => string);
  query?: (a: A, c: C) => Record<string, unknown>;
  headers?: (a: A, c: C) => Record<string, string>;
  body?: (a: A, c: C) => unknown;
  items: (data: any, a: A) => { id: string; [k: string]: unknown }[];
}

export interface HttpAppDef {
  key: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  category: string;
  docs?: string;
  auth?: { fields: AuthField[]; apply?: (h: Record<string, string>, c: C) => void; help?: string };
  actions?: HttpAction[];
  triggers?: HttpTrigger[];
}

const EVERY: Argument = { key: 'everyMinutes', label: 'Comprobar cada (minutos)', type: 'number', default: 5, required: true };

export const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function flattenForm(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) flattenForm(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function request(app: HttpAppDef, spec: HttpAction | HttpTrigger, a: A, c: C): Promise<any> {
  const url = new URL(typeof spec.url === 'function' ? spec.url(a, c) : spec.url);
  for (const [k, v] of Object.entries(spec.query?.(a, c) ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'AgentStudio/0.1', ...(spec.headers?.(a, c) ?? {}) };
  app.auth?.apply?.(headers, c);
  const method = spec.method ?? 'GET';
  let body: BodyInit | undefined;
  const raw = spec.body?.(a, c);
  const encoding = (spec as HttpAction).encoding ?? 'json';
  if (raw !== undefined && method !== 'GET') {
    if (encoding === 'form') { body = flattenForm(raw as Record<string, unknown>); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else if (encoding === 'text') { body = String(raw); headers['Content-Type'] ??= 'text/plain'; }
    else { body = JSON.stringify(raw); headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data).slice(0, 300) : String(data).slice(0, 300);
    throw new Error(`${app.name} respondió ${res.status}: ${msg}`);
  }
  return data;
}

async function creds(app: HttpAppDef, ctx: StepContext): Promise<C> {
  if (!app.auth) return {};
  const c = await ctx.connection(app.key, app.auth.fields.map((f) => f.key));
  const missing = app.auth.fields.filter((f) => !f.optional && !c[f.key]);
  if (missing.length) throw new Error(`Falta conectar ${app.name} (${missing.map((f) => f.label).join(', ')}). Ábrelo en el paso "Elegir conexión".`);
  return c;
}

export function httpApp(app: HttpAppDef): ModuleDef {
  return {
    key: app.key,
    name: app.name,
    description: app.description,
    icon: app.icon,
    color: app.color,
    category: app.category,
    author: 'Agent Studio',
    version: '1.0.0',
    homepage: app.docs,
    auth: app.auth ? { fields: app.auth.fields, help: app.auth.help } : undefined,
    actions: (app.actions ?? []).map((act) => ({
      key: act.key,
      name: act.name,
      description: act.description,
      arguments: act.args ?? [],
      async run(ctx: StepContext) {
        const c = await creds(app, ctx);
        if (act.run) return act.run(ctx, c);
        const data = await request(app, act, ctx.args, c);
        const err = act.check?.(data);
        if (err) throw new Error(`${app.name}: ${err}`);
        return act.pick ? act.pick(data, ctx.args) : data;
      },
    })),
    triggers: (app.triggers ?? []).map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      type: 'poll' as const,
      arguments: [...(t.args ?? []), EVERY],
      async run(ctx: StepContext) {
        const c = await creds(app, ctx);
        return t.items(await request(app, t, ctx.args, c), ctx.args).map((i) => ({ ...i, id: String(i.id) }));
      },
    })),
  };
}
