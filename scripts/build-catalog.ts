// Genera el catálogo de apps (modules/catalog/apps.json) y sus logos (public/logos/).
//
// Fuentes (abiertas):
//  - APIs.guru (CC0): especificaciones OpenAPI de cientos de servicios → acciones reales
//  - Registro oficial de MCP: servidores MCP remotos de marcas conocidas
//  - Simple Icons (CC0): logos SVG de marcas; si falta, el logo de la especificación
//    o el favicon del dominio. Las marcas son de sus dueños (solo identifican la app).
//
// Uso: npm run build:catalog   (descarga ~700 especificaciones; tarda unos minutos)
//      SI_DIR=/ruta/a/simple-icons/package para usar una copia local de Simple Icons
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { execFileSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'modules', 'catalog', 'apps.json');
const LOGOS = join(ROOT, 'public', 'logos');
const SI_DIR = process.env.SI_DIR ?? '/tmp/si/package';
const MAX_OPS = 15;
const MAX_ARGS = 7;

// Servicios internos de nubes gigantes (miles de APIs de infraestructura): fuera
const SKIP_PROVIDER = /^(azure\.com|googleapis\.com|amazonaws\.com|windows\.net|apis\.guru|amazon\.com)$/;

const CATEGORY: Record<string, string> = {
  financial: 'Finanzas y pagos', payment: 'Finanzas y pagos', ecommerce: 'Comercio',
  messaging: 'Comunicación', email: 'Email', telecom: 'Comunicación', social: 'Redes sociales',
  developer_tools: 'Desarrollo', hosting: 'Desarrollo', backend: 'Desarrollo', cloud: 'Desarrollo', monitoring: 'Desarrollo', storage: 'Archivos',
  analytics: 'Analítica', marketing: 'Marketing', media: 'Multimedia', entertainment: 'Multimedia',
  open_data: 'Datos abiertos', location: 'Mapas y transporte', transport: 'Mapas y transporte',
  collaboration: 'Productividad', project_management: 'Productividad', time_management: 'Productividad', tools: 'Productividad', forms: 'Formularios',
  customer_relation: 'CRM', support: 'Soporte', enterprise: 'Empresa', education: 'Educación',
  machine_learning: 'IA', text: 'IA', search: 'IA', security: 'Seguridad', iot: 'IoT',
};

// ---------- utilidades ----------
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
function clean(text = '', max = 160): string {
  const t = text.replace(/<[^>]+>/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();
  const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
  return (first.length > max ? first.slice(0, max - 1) + '…' : first);
}
async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
async function get(url: string, ms = 30_000): Promise<Response | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'AgentStudio-catalog/1.0' } });
    return r.ok ? r : null;
  } catch { return null; }
}

// ---------- Simple Icons ----------
interface SI { title: string; slug: string; hex: string; aliases?: { aka?: string[] } }
const siList: SI[] = existsSync(join(SI_DIR, 'data/simple-icons.json')) ? JSON.parse(readFileSync(join(SI_DIR, 'data/simple-icons.json'), 'utf8')) : [];
if (!siList.length) console.warn('⚠ Simple Icons no encontrado en', SI_DIR, '(npm pack simple-icons y descomprime en /tmp/si)');
const siByName = new Map<string, SI>();
for (const ic of siList) {
  for (const n of [ic.title, ic.slug, ...(ic.aliases?.aka ?? [])]) if (!siByName.has(norm(n))) siByName.set(norm(n), ic);
}
function findIcon(...names: (string | undefined)[]): SI | undefined {
  for (const n of names) {
    if (!n) continue;
    const k = norm(n);
    if (k.length >= 3 && siByName.has(k)) return siByName.get(k);
  }
}
// Logo en color de marca (los SVG de Simple Icons vienen sin color)
function siSvg(ic: SI): string {
  const raw = readFileSync(join(SI_DIR, 'icons', `${ic.slug}.svg`), 'utf8');
  const hex = luminance(ic.hex) > 0.85 ? '1f2937' : ic.hex; // marcas blancas/amarillo claro: se verían sobre blanco
  return raw.replace('<svg ', `<svg fill="#${hex}" `);
}
function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Guarda el logo de una app: Simple Icons > imagen de la fuente > favicon del dominio
async function saveLogo(key: string, opts: { names: string[]; image?: string; domain?: string }): Promise<{ logo?: string; color?: string }> {
  const ic = findIcon(...opts.names);
  if (ic) {
    await writeFile(join(LOGOS, `${key}.svg`), siSvg(ic));
    return { logo: `/logos/${key}.svg`, color: `#${ic.hex}` };
  }
  for (const url of [opts.image, opts.domain ? `https://www.google.com/s2/favicons?domain=${opts.domain}&sz=128` : undefined]) {
    if (!url) continue;
    const r = await get(url, 15_000);
    if (!r) continue;
    const type = r.headers.get('content-type') ?? '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200 || !/image\//.test(type)) continue; // favicon genérico vacío
    const ext = type.includes('svg') ? 'svg' : type.includes('png') ? 'png' : type.includes('gif') ? 'gif' : type.includes('webp') ? 'webp' : 'jpg';
    if (ext === 'svg' && buf.length > 80_000) continue; // SVG con imágenes incrustadas: demasiado pesado
    const file = join(LOGOS, `${key}.${ext}`);
    await writeFile(file, buf);
    if (ext !== 'svg' && buf.length > 20_000) {
      // reduce a 128 px (sips viene con macOS; si no está, se queda tal cual)
      try { execFileSync('sips', ['-Z', '128', file], { stdio: 'ignore' }); } catch {}
    }
    return { logo: `/logos/${key}.${ext}` };
  }
  return {};
}

// ---------- OpenAPI → acciones ----------
interface Param { n: string; in: 'path' | 'query' | 'header'; r?: boolean; t?: 'string' | 'number' | 'boolean' | 'dropdown'; d?: string; o?: string[] }
interface Op { key: string; name: string; m: string; p: string; params: Param[]; body?: string }
type Auth = { type: 'none' } | { type: 'key'; in: 'header' | 'query'; name: string } | { type: 'bearer' } | { type: 'basic' };

function resolve(spec: any, obj: any, depth = 0): any {
  if (!obj || depth > 4) return obj;
  if (obj.$ref && typeof obj.$ref === 'string' && obj.$ref.startsWith('#/')) {
    return resolve(spec, obj.$ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec), depth + 1);
  }
  return obj;
}

// Esqueleto del cuerpo a partir del esquema (solo primer nivel, para orientar)
function skeleton(spec: any, schema: any): string | undefined {
  const s = resolve(spec, schema);
  const props = s?.properties ?? resolve(spec, s?.allOf?.[0])?.properties;
  if (!props) return undefined;
  const req = new Set<string>(s.required ?? []);
  const keys = Object.keys(props).sort((a, b) => Number(req.has(b)) - Number(req.has(a))).slice(0, 6);
  const ex: Record<string, unknown> = {};
  for (const k of keys) {
    const p = resolve(spec, props[k]) ?? {};
    ex[k] = p.example ?? (p.enum?.[0]) ?? (p.type === 'integer' || p.type === 'number' ? 0 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : '');
  }
  return JSON.stringify(ex, null, 1).replace(/\n\s*/g, ' ');
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
function operations(spec: any): { ops: Op[]; total: number } {
  const all: (Op & { score: number })[] = [];
  const used = new Set<string>();
  for (const [path, item0] of Object.entries<any>(spec.paths ?? {})) {
    const item = resolve(spec, item0) ?? {};
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const params: Param[] = [];
      let body: string | undefined;
      let hasBody = false;
      for (const p0 of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const p = resolve(spec, p0);
        if (!p?.name) continue;
        if (p.in === 'body') { hasBody = true; body = skeleton(spec, p.schema); continue; }
        if (p.in === 'formData') { hasBody = true; continue; }
        if (!['path', 'query', 'header'].includes(p.in)) continue;
        if (p.in === 'header' && (!p.required || /^(authorization|accept|content-type|x-api-key|api-key)$/i.test(p.name))) continue;
        const sch = resolve(spec, p.schema) ?? p;
        const en = sch.enum?.filter((x: unknown) => typeof x === 'string' || typeof x === 'number').map(String);
        const t = en?.length ? 'dropdown' : sch.type === 'integer' || sch.type === 'number' ? 'number' : sch.type === 'boolean' ? 'boolean' : undefined;
        const prm: Param = { n: p.name, in: p.in, ...(p.required || p.in === 'path' ? { r: true } : {}), ...(t ? { t } : {}) };
        const d = clean(p.description ?? '', 90);
        if (d) prm.d = d;
        if (en?.length) prm.o = en.slice(0, 30);
        if (!params.some((x) => x.n === prm.n && x.in === prm.in)) params.push(prm);
      }
      if (op.requestBody) {
        hasBody = true;
        const rb = resolve(spec, op.requestBody);
        const content = rb?.content ?? {};
        const ct = content['application/json'] ?? Object.values<any>(content)[0];
        body = skeleton(spec, ct?.schema);
      }
      params.sort((a, b) => Number(Boolean(b.r)) - Number(Boolean(a.r)));
      const kept = params.filter((p) => p.r).concat(params.filter((p) => !p.r)).slice(0, Math.max(MAX_ARGS, params.filter((p) => p.r).length));
      const id = String(op.operationId ?? `${m}-${path}`);
      let key = slug(id) || slug(`${m}-${path}`) || `op-${all.length}`;
      while (used.has(key)) key += '-2';
      used.add(key);
      const name = clean(op.summary ?? '', 80) || clean(op.description ?? '', 80) || id.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
      const depth = path.split('/').filter(Boolean).length;
      const score = (op.deprecated ? 100 : 0) + depth * 2 + METHODS.indexOf(m) + (op.summary ? 0 : 3) + params.filter((p) => p.r).length;
      all.push({ key, name: name.charAt(0).toUpperCase() + name.slice(1), m: m.toUpperCase(), p: path, params: kept, ...(hasBody ? { body: body ?? '{}' } : {}), score });
    }
  }
  const ops = all.sort((a, b) => a.score - b.score).slice(0, MAX_OPS).map(({ score: _s, ...o }) => o);
  return { ops, total: all.length };
}

function auth(spec: any): Auth {
  const schemes: Record<string, any> = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  const wanted = [...(spec.security ?? []), ...Object.values<any>(spec.paths ?? {}).flatMap((i) => METHODS.flatMap((m) => i?.[m]?.security ?? []))]
    .flatMap((req: Record<string, unknown>) => Object.keys(req ?? {}));
  const names = [...new Set([...wanted, ...Object.keys(schemes)])];
  for (const n of names) {
    const s = resolve(spec, schemes[n]);
    if (!s) continue;
    if (s.type === 'apiKey' && (s.in === 'header' || s.in === 'query')) {
      if (s.in === 'header' && /^authorization$/i.test(s.name)) return { type: 'bearer' };
      return { type: 'key', in: s.in, name: s.name };
    }
    if (s.type === 'http' && /bearer/i.test(s.scheme)) return { type: 'bearer' };
    if ((s.type === 'http' && /basic/i.test(s.scheme)) || s.type === 'basic') return { type: 'basic' };
    if (s.type === 'oauth2' || s.type === 'openIdConnect') return { type: 'bearer' };
  }
  return { type: 'none' };
}

function baseUrl(spec: any, provider: string): { base: string; needsBase: boolean } {
  const srv = spec.servers?.find((s: any) => /^https:/.test(s.url)) ?? spec.servers?.[0];
  if (srv?.url) {
    let url: string = srv.url;
    let needsBase = false;
    url = url.replace(/\{([^}]+)\}/g, (_: string, v: string) => {
      const d = srv.variables?.[v]?.default;
      if (d === undefined || d === '') needsBase = true;
      return d ?? `{${v}}`;
    });
    if (!/^https?:\/\//.test(url)) url = `https://${provider}${url.startsWith('/') ? '' : '/'}${url}`;
    return { base: url.replace(/\/$/, ''), needsBase: needsBase || /localhost|127\.0\.0\.1|example\.com/.test(url) };
  }
  if (spec.host) {
    const scheme = (spec.schemes ?? []).includes('https') ? 'https' : (spec.schemes?.[0] ?? 'https');
    return { base: `${scheme}://${spec.host}${spec.basePath ?? ''}`.replace(/\/$/, ''), needsBase: /localhost|example\.com/.test(spec.host) };
  }
  return { base: `https://${provider}`, needsBase: true };
}

function brandOf(provider: string): string {
  const parts = provider.replace(/^(api|www|developer|developers)\./, '').split('.');
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function prettyName(info: any, provider: string): string {
  let t = String(info?.title ?? '').replace(/\s*(REST|HTTP|Public|Open|Web)?\s*API(s)?\b.*$/i, '').replace(/\s+v?\d+(\.\d+)*$/i, '').trim();
  t = t.split(/\s+[-–|:(]\s*|,\s+/)[0].trim(); // "Api2Pdf - PDF Generation…" → "Api2Pdf"
  const brand = brandOf(provider);
  // dominios de alojamiento genérico: la marca no es el dominio
  if (/^(herokuapp|azurewebsites|github|appspot|netlify|vercel|co|com|api|apis|cloud|run|amazonaws|ngrok|glitch|repl|onrender|fly)$/i.test(brand)) return t && t.length <= 32 ? t : cap(provider.split('.')[0]);
  const ic = findIcon(brand, t);
  if (ic && (norm(ic.title) === norm(brand) || norm(t).includes(norm(ic.title)))) return ic.title;
  if (t && norm(t).includes(norm(brand)) && t.length <= 32) return t;
  if (t && t.split(/\s+/).length >= 2 && t.length <= 28 && !/^(platform|control|registry|fast|service|api|core|public)$/i.test(t)) return t;
  return brand.length < 3 && t ? t : cap(brand);
}

// Servidores MCP remotos oficiales conocidos (se comprueba que respondan al generar)
const OFFICIAL_MCP: { name: string; url: string; transport?: 'http' | 'sse'; brand: string; docs?: string; category?: string; desc: string }[] = [
  { name: 'Notion', brand: 'notion', url: 'https://mcp.notion.com/mcp', desc: 'Busca, lee y crea páginas y bases de datos de Notion.' },
  { name: 'Linear', brand: 'linear', url: 'https://mcp.linear.app/mcp', desc: 'Crea y actualiza issues, proyectos y ciclos de Linear.' },
  { name: 'Atlassian (Jira y Confluence)', brand: 'atlassian', url: 'https://mcp.atlassian.com/v1/mcp', desc: 'Issues de Jira y páginas de Confluence.' },
  { name: 'Asana', brand: 'asana', url: 'https://mcp.asana.com/sse', transport: 'sse', desc: 'Tareas, proyectos y comentarios de Asana.' },
  { name: 'Sentry', brand: 'sentry', url: 'https://mcp.sentry.dev/mcp', desc: 'Errores, issues y releases de Sentry.' },
  { name: 'Stripe', brand: 'stripe', url: 'https://mcp.stripe.com', desc: 'Clientes, pagos, suscripciones y facturas de Stripe.' },
  { name: 'PayPal', brand: 'paypal', url: 'https://mcp.paypal.com/mcp', desc: 'Facturas, pedidos y pagos de PayPal.' },
  { name: 'Square', brand: 'square', url: 'https://mcp.squareup.com/sse', transport: 'sse', desc: 'Pagos, catálogo y clientes de Square.' },
  { name: 'Plaid', brand: 'plaid', url: 'https://api.dashboard.plaid.com/mcp/sse', transport: 'sse', desc: 'Diagnóstico y analítica de integraciones de Plaid.' },
  { name: 'GitHub', brand: 'github', url: 'https://api.githubcopilot.com/mcp/', desc: 'Repos, issues, pull requests y acciones de GitHub.' },
  { name: 'GitLab', brand: 'gitlab', url: 'https://gitlab.com/api/v4/mcp', desc: 'Proyectos, issues y merge requests de GitLab.' },
  { name: 'Hugging Face', brand: 'huggingface', url: 'https://huggingface.co/mcp', desc: 'Modelos, datasets y Spaces de Hugging Face.' },
  { name: 'Cloudflare Docs', brand: 'cloudflare', url: 'https://docs.mcp.cloudflare.com/mcp', desc: 'Documentación de Cloudflare.' },
  { name: 'Vercel', brand: 'vercel', url: 'https://mcp.vercel.com', desc: 'Proyectos, despliegues y logs de Vercel.' },
  { name: 'Netlify', brand: 'netlify', url: 'https://netlify-mcp.netlify.app/mcp', desc: 'Sitios y despliegues de Netlify.' },
  { name: 'Supabase', brand: 'supabase', url: 'https://mcp.supabase.com/mcp', desc: 'Bases de datos, tablas y funciones de Supabase.' },
  { name: 'Neon', brand: 'neon', url: 'https://mcp.neon.tech/mcp', desc: 'Bases de datos Postgres serverless de Neon.' },
  { name: 'Prisma', brand: 'prisma', url: 'https://mcp.prisma.io/mcp', desc: 'Bases de datos Prisma Postgres.' },
  { name: 'Figma', brand: 'figma', url: 'https://mcp.figma.com/mcp', desc: 'Diseños, componentes y variables de Figma.' },
  { name: 'Canva', brand: 'canva', url: 'https://mcp.canva.com/mcp', desc: 'Diseños y recursos de Canva.' },
  { name: 'Webflow', brand: 'webflow', url: 'https://mcp.webflow.com/sse', transport: 'sse', desc: 'Sitios, CMS y páginas de Webflow.' },
  { name: 'Wix', brand: 'wix', url: 'https://mcp.wix.com/sse', transport: 'sse', desc: 'Sitios, tienda y reservas de Wix.' },
  { name: 'Intercom', brand: 'intercom', url: 'https://mcp.intercom.com/mcp', desc: 'Conversaciones y contactos de Intercom.' },
  { name: 'monday.com', brand: 'mondaydotcom', url: 'https://mcp.monday.com/mcp', desc: 'Tableros, elementos y actualizaciones de monday.com.' },
  { name: 'Box', brand: 'box', url: 'https://mcp.box.com', desc: 'Archivos y carpetas de Box.' },
  { name: 'HubSpot', brand: 'hubspot', url: 'https://mcp.hubspot.com', desc: 'Contactos, empresas y negocios de HubSpot.' },
  { name: 'Zapier', brand: 'zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', desc: 'Miles de acciones de Zapier desde un solo servidor MCP.' },
  { name: 'Semgrep', brand: 'semgrep', url: 'https://mcp.semgrep.ai/mcp', desc: 'Análisis de seguridad del código.' },
  { name: 'Exa', brand: 'exa', url: 'https://mcp.exa.ai/mcp', desc: 'Búsqueda web pensada para IA.' },
  { name: 'DeepWiki', brand: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', desc: 'Documentación de cualquier repositorio de GitHub (sin clave).' },
  { name: 'Context7', brand: 'context7', url: 'https://mcp.context7.com/mcp', desc: 'Documentación actualizada de librerías (sin clave).' },
  { name: 'Airtable', brand: 'airtable', url: 'https://mcp.airtable.com/mcp', desc: 'Bases, tablas y registros de Airtable.' },
  { name: 'ClickUp', brand: 'clickup', url: 'https://mcp.clickup.com/mcp', desc: 'Tareas y espacios de ClickUp.' },
  { name: 'Cloudinary', brand: 'cloudinary', url: 'https://asset-management.mcp.cloudinary.com/sse', transport: 'sse', desc: 'Imágenes y vídeos de Cloudinary.' },
  { name: 'Shopify Dev', brand: 'shopify', url: 'https://shopify.dev/mcp', desc: 'Documentación y APIs de Shopify.' },
  { name: 'Mercado Pago', brand: 'mercadopago', url: 'https://mcp.mercadopago.com/mcp', desc: 'Pagos y documentación de Mercado Pago.' },
  { name: 'Dynatrace', brand: 'dynatrace', url: 'https://mcp.dynatrace.com/mcp', desc: 'Observabilidad de Dynatrace.' },
  { name: 'PostHog', brand: 'posthog', url: 'https://mcp.posthog.com/mcp', desc: 'Analítica de producto, flags y experimentos de PostHog.' },
  { name: 'Ramp', brand: 'ramp', url: 'https://mcp.ramp.com/mcp', desc: 'Gastos y tarjetas corporativas de Ramp.' },
  { name: 'Grafana', brand: 'grafana', url: 'https://mcp.grafana.com/mcp', desc: 'Dashboards y alertas de Grafana.' },
];

// ¿Responde como servidor MCP? (200/202 a initialize, o 401/403 pidiendo autenticación)
async function probeMcp(url: string, transport: 'http' | 'sse' = 'http'): Promise<boolean> {
  try {
    const r = transport === 'sse'
      ? await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: AbortSignal.timeout(8000) })
      : await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-studio-probe', version: '1' } } }), signal: AbortSignal.timeout(8000) });
    r.body?.cancel().catch(() => {});
    return [200, 202, 401, 403].includes(r.status);
  } catch { return false; }
}

// ¿Sigue existiendo el servidor de la API? (cualquier respuesta HTTP vale)
async function hostAlive(base: string): Promise<boolean> {
  try {
    const r = await fetch(base, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    r.body?.cancel().catch(() => {});
    return r.status < 600;
  } catch { return false; }
}

// Nombres que la heurística no adivina
const RENAME: Record<string, string> = { Video: 'api.video', Dev: 'DEV Community', Epa: 'EPA ECHO', Org: 'OpenAPI Webconverter', Nrm: 'Naturhistoriska riksmuseet', Up: 'Up Bank', 'Quick start': 'Telematics SDK' };

// ---------- principal ----------
interface CatalogApp {
  key: string; name: string; description: string; category: string; color: string; logo?: string;
  docs?: string; source: 'openapi' | 'mcp'; spec?: string; base?: string; needsBase?: boolean; auth?: Auth;
  ops?: Op[]; totalOps?: number; mcpUrl?: string; mcpTransport?: 'http' | 'sse'; mcpHeaders?: { name: string; secret?: boolean; description?: string }[];
}

async function main() {
  await mkdir(LOGOS, { recursive: true });
  await mkdir(join(ROOT, 'modules', 'catalog'), { recursive: true });

  // Claves ya usadas por los módulos hechos a mano (esos tienen prioridad)
  const taken = new Set<string>();
  for (const dir of await readdir(join(ROOT, 'modules'), { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'catalog' || dir.name.startsWith('_')) continue;
    const src = readFileSync(join(ROOT, 'modules', dir.name, existsSync(join(ROOT, 'modules', dir.name, 'index.ts')) ? 'index.ts' : 'index.js'), 'utf8');
    for (const m of src.matchAll(/\bkey:\s*'([a-z0-9-]+)',\s*name:/g)) taken.add(m[1]);
  }
  const takenNorm = new Set([...taken].map(norm));

  // ---- APIs.guru ----
  console.log('Descargando el índice de APIs.guru…');
  const list = await (await get('https://api.apis.guru/v2/list.json', 60_000))!.json() as Record<string, any>;
  const byProvider = new Map<string, string[]>();
  for (const k of Object.keys(list)) {
    const p = k.split(':')[0];
    if (SKIP_PROVIDER.test(p)) continue;
    byProvider.set(p, [...(byProvider.get(p) ?? []), k]);
  }
  // Un API por proveedor: la principal (sin servicio, o la que se llama "api")
  const picks = [...byProvider.entries()].map(([p, keys]) => keys.sort((a, b) => {
    const s = (k: string) => (k.includes(':') ? 1 : 0) + (/ghes|enterprise|beta|sandbox|test|legacy|v1$/i.test(k) ? 5 : 0) - (/:api\b|:api\./.test(k) ? 1 : 0) + k.length / 100;
    return s(a) - s(b);
  })[0]);
  console.log(`${picks.length} proveedores; descargando especificaciones…`);

  let done = 0;
  const fromGuru: CatalogApp[] = (await pool(picks, 16, async (k): Promise<CatalogApp | null> => {
    const v = list[k].versions[list[k].preferred];
    const provider = k.split(':')[0];
    const r = await get(v.swaggerUrl ?? v.openapiUrl, 40_000);
    if (++done % 50 === 0) console.log(`  ${done}/${picks.length}`);
    if (!r) return null;
    let spec: any;
    try { const t = await r.text(); spec = t.trim().startsWith('{') ? JSON.parse(t) : YAML.parse(t); } catch { return null; }
    const { ops, total } = operations(spec);
    if (!ops.length) return null;
    const name = prettyName(v.info, provider);
    const base = brandOf(provider);
    let key = slug(name) || slug(base);
    if (!key || taken.has(key) || takenNorm.has(norm(name)) || takenNorm.has(norm(base))) return null; // ya existe a mano
    const cat = (v.info['x-apisguru-categories'] ?? []).map((c: string) => CATEGORY[c]).find(Boolean) ?? 'Otros';
    const { base: url, needsBase } = baseUrl(spec, provider);
    if (!needsBase && !(await hostAlive(url))) return null; // API desaparecida
    return {
      key, name, category: cat, color: '#4f46e5', source: 'openapi',
      description: clean(v.info.description ?? spec.info?.description ?? '') || `API de ${name}`,
      docs: spec.externalDocs?.url ?? v.info['x-origin']?.[0]?.url ?? `https://${provider}`,
      spec: v.swaggerUrl ?? v.openapiUrl, base: url, needsBase, auth: auth(spec), ops, totalOps: total,
      // datos temporales para el logo
      ...({ _logo: v.info['x-logo']?.url, _domain: provider, _names: [name, base] } as object),
    };
  })).filter(Boolean) as CatalogApp[];

  // Un nombre por app (dos especificaciones del mismo proveedor → se queda la primera)
  const names = new Set<string>();
  const uniq: CatalogApp[] = [];
  for (const a of fromGuru) { if (names.has(norm(a.name))) continue; names.add(norm(a.name)); uniq.push(a); }
  fromGuru.length = 0; fromGuru.push(...uniq);
  // Claves únicas
  const keys = new Set(taken);
  for (const a of fromGuru) { let k = a.key; let i = 2; while (keys.has(k)) k = `${a.key}-${i++}`; a.key = k; keys.add(k); }
  console.log(`APIs.guru: ${fromGuru.length} apps con acciones`);

  // ---- Registro MCP: solo marcas reconocibles (con logo en Simple Icons o ya en el catálogo) ----
  const regFile = '/tmp/mcpreg.json';
  let servers: any[] = existsSync(regFile) ? JSON.parse(readFileSync(regFile, 'utf8')) : [];
  if (!servers.length) {
    let cursor = '';
    for (let i = 0; i < 80; i++) {
      const r = await get(`https://registry.modelcontextprotocol.io/v0/servers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!r) break;
      const j = await r.json() as any;
      servers.push(...j.servers);
      cursor = j.metadata?.nextCursor;
      if (!cursor) break;
    }
  }
  const meta = (s: any) => s._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
  const guruNames = new Set(fromGuru.map((a) => norm(a.name)));
  const mcpApps: CatalogApp[] = [];
  const seen = new Set<string>();
  const sld = (host: string) => { const p = host.split('.'); return p.length > 1 ? p[p.length - 2] : p[0]; };
  const candidates: { name: string; url: string; transport: 'http' | 'sse'; ic?: SI; desc: string; docs?: string; headers?: any[] }[] = [];
  for (const o of OFFICIAL_MCP) candidates.push({ name: o.name, url: o.url, transport: o.transport ?? 'http', ic: siList.find((x) => x.slug === o.brand) ?? findIcon(o.brand, o.name), desc: o.desc, docs: o.docs });
  for (const s of servers) {
    const sv = s.server;
    if (meta(s).status !== 'active' || meta(s).isLatest === false) continue;
    const remote = sv.remotes?.find((r: any) => r.type === 'streamable-http' && /^https:/.test(r.url ?? '') && !/\{/.test(r.url));
    if (!remote) continue;
    // Oficial = el espacio de nombres (com.marca/…) coincide con el dominio del servidor y con un logo conocido
    const ns = String(sv.name).split('/')[0].split('.');
    const brand = ns.length >= 2 ? ns[1] : ns[0];
    const host = new URL(remote.url).hostname;
    if (sld(host) !== brand) continue;
    const ic = siList.find((x) => x.slug === brand || norm(x.title) === brand);
    if (!ic) continue;
    candidates.push({ name: String(sv.title ?? ic.title), url: remote.url, transport: 'http', ic, desc: clean(sv.description ?? ''), docs: sv.websiteUrl ?? sv.repository?.url, headers: remote.headers });
  }
  const alive = await pool(candidates, 12, (c) => probeMcp(c.url, c.transport));
  candidates.forEach((c, i) => {
    if (!alive[i]) { console.log(`  MCP sin respuesta, descartado: ${c.name} (${c.url})`); return; }
    const id = c.ic?.slug ?? slug(c.name);
    if (seen.has(id)) return;
    seen.add(id);
    const title = c.ic?.title ?? c.name;
    const key = `${slug(title)}-mcp`;
    if (keys.has(key)) return;
    keys.add(key);
    mcpApps.push({
      key, name: `${c.name}${guruNames.has(norm(c.name)) || takenNorm.has(norm(c.name)) ? ' (MCP)' : ''}`,
      description: c.desc || `Servidor MCP de ${title}`, category: 'MCP', color: c.ic ? `#${c.ic.hex}` : '#111827', source: 'mcp', docs: c.docs,
      mcpUrl: c.url, mcpTransport: c.transport,
      mcpHeaders: (c.headers ?? []).map((h: any) => ({ name: h.name, secret: h.isSecret, description: clean(h.description ?? '', 120) })),
      ...({ _names: [title, c.name], _domain: new URL(c.url).hostname.split('.').slice(-2).join('.') } as object),
    });
  });
  console.log(`Registro MCP: ${mcpApps.length} servidores de marcas conocidas`);

  // ---- Logos ----
  const apps = [...fromGuru, ...mcpApps];
  let withLogo = 0;
  done = 0;
  await pool(apps, 12, async (a: any) => {
    const r = await saveLogo(a.key, { names: a._names, image: a._logo, domain: a._domain });
    if (r.logo) { a.logo = r.logo; withLogo++; }
    if (r.color) a.color = r.color;
    delete a._names; delete a._logo; delete a._domain;
    if (++done % 100 === 0) console.log(`  logos ${done}/${apps.length}`);
  });

  // Logos de los módulos hechos a mano (por nombre o por el dominio de su documentación)
  const handLogos: Record<string, string> = {};
  for (const dir of await readdir(join(ROOT, 'modules'), { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'catalog' || dir.name.startsWith('_')) continue;
    const file = join(ROOT, 'modules', dir.name, 'index.ts');
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\{\s*key:\s*'([a-z0-9-]+)',\s*name:\s*'([^']+)'[^\n]*?(?:docs|homepage):\s*'([^']+)'/g)) {
      const [, key, name, docs] = m;
      if (existsSync(join(LOGOS, 'ui', `${key}.svg`))) continue;
      const host = (() => { try { return new URL(docs).hostname.split('.').slice(-2).join('.'); } catch { return undefined; } })();
      const r = await saveLogo(key, { names: [name, key, name.split(/\s+/)[0]], domain: host });
      if (r.logo) handLogos[key] = r.logo;
    }
  }

  for (const a of apps) if (RENAME[a.name]) a.name = RENAME[a.name];
  const byCat: Record<string, number> = {};
  for (const a of apps) byCat[a.category] = (byCat[a.category] ?? 0) + 1;
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), sources: ['APIs.guru (CC0)', 'MCP Registry', 'Simple Icons (CC0)'], apps }));
  console.log(`\n✓ ${apps.length} apps en el catálogo (${withLogo} con logo), ${Object.keys(handLogos).length} logos para módulos hechos a mano`);
  console.log(byCat);
}

main().catch((e) => { console.error(e); process.exit(1); });
