// Utilidades HTTP y tabla de rutas de la API interna (/api/*).
//
// Cada ruta declara qué necesita y el middleware de server.ts lo comprueba con
// can() antes de llamar al handler (la interfaz oculta lo que no se puede usar,
// pero la seguridad se valida siempre aquí):
//
//   route('GET', '/api/agents', { perm: 'agents.read' }, handler)
//   route('POST', '/api/crm/contacts', { feature: 'crm', perm: 'crm.contacts.write' }, handler)
//   route('GET', '/api/platform/tenants', { platform: true }, handler)    // solo superadmin
//   route('GET', '/api/me/context', { noTenant: true }, handler)         // sin empresa activa
//
// Un módulo nuevo registra sus rutas con requireFeature()/requirePermission() o
// directamente con estas opciones (ver FEATURES.md).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { Ctx } from './authz/context.ts';

export async function readBody(req: IncomingMessage, limit = 50 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function json<T>(req: IncomingMessage): Promise<T> {
  const raw = (await readBody(req)).toString('utf8');
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

export function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// JSON grande (la lista de módulos son varios MB): se comprime si el navegador acepta gzip
export function sendBig(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const raw = Buffer.from(JSON.stringify(body));
  if (raw.length < 50_000 || !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return send(res, status, raw);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  res.end(gzipSync(raw));
}

export const ipOf = (req: IncomingMessage): string | null =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || null;

export const query = (req: IncomingMessage) => new URL(req.url ?? '/', 'http://x').searchParams;

export interface RouteOpts {
  perm?: string; // permiso requerido
  anyPerm?: string[]; // basta con uno de estos
  feature?: string; // módulo que debe estar activo y configurado
  platform?: boolean; // solo superadmin
  noTenant?: boolean; // no necesita empresa activa (ctx puede ser null)
}

export type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], ctx: Ctx) => Promise<void>;
export interface Route { method: string; re: RegExp; opts: RouteOpts; handler: Handler }

export const routes: Route[] = [];

export function route(method: string, pattern: string, opts: RouteOpts | Handler, handler?: Handler): void {
  const h = (typeof opts === 'function' ? opts : handler)!;
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), opts: typeof opts === 'function' ? {} : opts, handler: h });
}

// Atajos con el vocabulario del diseño
export const requireFeature = (feature: string, perm?: string): RouteOpts => ({ feature, perm });
export const requirePermission = (perm: string): RouteOpts => ({ perm });
