// Resolución central de rutas de archivos por empresa. Todo lo que se guarda en
// disco pasa por aquí:
//
//   data/tenants/<tenant_id>/connections.json, metrics/, flows/, files/
//   agents/<tenant_id>/<agente>/
//
// Cada segmento se valida (sin "..", sin barras, sin rutas absolutas) y la ruta
// final debe quedar dentro de la carpeta de la empresa.
import { join, resolve, sep } from 'node:path';
import { ROOT } from '../root.ts';

// Carpetas base; se pueden cambiar (p. ej. en las pruebas) con estas variables
export const DATA_DIR = resolve(process.env.AGENT_STUDIO_DATA_DIR || join(ROOT, 'data'));
export const AGENTS_BASE = resolve(process.env.AGENT_STUDIO_AGENTS_DIR || join(ROOT, 'agents'));
export const TENANTS_DIR = join(DATA_DIR, 'tenants');

// La empresa "Default" siempre tiene el id 1 (la crea la migración)
export const DEFAULT_TENANT_ID = 1;
export const DEFAULT_TENANT_SLUG = 'default';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertTenant(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw fail(400, 'Empresa no válida');
  return id;
}

// Une segmentos bajo base sin permitir salir de ella
export function safeJoin(base: string, ...parts: string[]): string {
  for (const p of parts) {
    if (typeof p !== 'string' || !SEGMENT.test(p) || p.includes('..')) throw fail(400, `Ruta no válida: ${String(p).slice(0, 60)}`);
  }
  const full = resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + sep)) throw fail(400, 'Ruta fuera de la carpeta permitida');
  return full;
}

// data/tenants/<id>/...
export function tenantDataPath(tenantId: number, ...parts: string[]): string {
  return safeJoin(safeJoin(TENANTS_DIR, String(assertTenant(tenantId))), ...parts);
}

// agents/<id>/...
export function tenantAgentsPath(tenantId: number, ...parts: string[]): string {
  return safeJoin(safeJoin(AGENTS_BASE, String(assertTenant(tenantId))), ...parts);
}
