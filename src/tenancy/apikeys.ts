// Claves de API por empresa (para /v1 y /mcp). Cada clave tiene scopes, que son
// un subconjunto de los permisos de quien la creó. Se guarda solo su SHA-256 y
// un prefijo visible; la clave completa se muestra una única vez.
//
// Compatibilidad: AGENT_STUDIO_API_KEY (y, sin MariaDB, data/api-key) siguen
// funcionando como clave de la empresa Default con todos los permisos.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { dbEnabled, parseJson } from '../db/pool.ts';
import { tenantDb } from '../db/tenant-db.ts';
import { findApiKeyByHash } from './platform.ts';
import { allPermissions, isKnownPermission } from '../authz/permissions.ts';
import { DATA_DIR, DEFAULT_TENANT_ID } from './paths.ts';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export interface ApiKeyInfo { id: number; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
export interface ApiKeyAuth { tenantId: number; keyId: number | null; name: string; permissions: Set<string> }

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

// '*' (solo la clave migrada) = todos los permisos, también los de módulos futuros
export function expandScopes(scopes: string[]): Set<string> {
  return new Set(scopes.includes('*') ? allPermissions() : scopes.filter(isKnownPermission));
}

export async function listApiKeys(tenantId: number): Promise<ApiKeyInfo[]> {
  const rows = await tenantDb(tenantId).query('SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE tenant_id = :tenant ORDER BY id DESC');
  return rows.map((r: any) => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: parseJson<string[]>(r.scopes, []), createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at) }));
}

export async function createApiKey(tenantId: number, input: { name?: string; scopes?: string[] }, actor: { userId: number | null; permissions: Set<string> }): Promise<{ key: string; info: ApiKeyInfo }> {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 80) throw fail(400, 'Ponle un nombre a la clave (máximo 80 caracteres).');
  const scopes = [...new Set((input.scopes ?? []).map(String))];
  if (!scopes.length) throw fail(400, 'Elige al menos un permiso para la clave.');
  const unknown = scopes.filter((s) => !isKnownPermission(s));
  if (unknown.length) throw fail(400, `Permisos desconocidos: ${unknown.join(', ')}`);
  const extra = scopes.filter((s) => !actor.permissions.has(s));
  if (extra.length) throw fail(403, `Una clave no puede tener permisos que tú no tienes: ${extra.join(', ')}`);
  const key = `as_${randomBytes(30).toString('base64url')}`;
  const r = await tenantDb(tenantId).query('INSERT INTO api_keys (tenant_id, name, key_hash, prefix, scopes, created_by) VALUES (:tenant, ?, ?, ?, ?, ?)', [name, sha(key), key.slice(0, 12), JSON.stringify(scopes), actor.userId]);
  const info = (await listApiKeys(tenantId)).find((k) => k.id === r.insertId)!;
  return { key, info };
}

export async function revokeApiKey(tenantId: number, id: number): Promise<ApiKeyInfo> {
  const r = await tenantDb(tenantId).query('UPDATE api_keys SET revoked_at = NOW() WHERE tenant_id = :tenant AND id = ? AND revoked_at IS NULL', [Number(id)]);
  if (!r.affectedRows) throw fail(404, 'Clave no encontrada o ya revocada');
  return (await listApiKeys(tenantId)).find((k) => k.id === Number(id))!;
}

// ---------- verificación ----------

function supplied(req: IncomingMessage): string {
  const header = req.headers.authorization;
  const v = (typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7) : req.headers['x-api-key']) ?? '';
  return typeof v === 'string' ? v.trim() : '';
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Sin MariaDB: la clave local de siempre (data/api-key), de la empresa Default
let localKey: string | undefined;
export function localApiKey(): string {
  if (localKey) return localKey;
  const file = join(DATA_DIR, 'api-key');
  if (existsSync(file)) localKey = readFileSync(file, 'utf8').trim();
  if (!localKey) {
    localKey = `as_${randomBytes(24).toString('base64url')}`;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, `${localKey}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return localKey;
}

const lastTouch = new Map<number, number>();

// Acepta "Authorization: Bearer <clave>" o "x-api-key: <clave>"
export async function verifyApiKey(req: IncomingMessage): Promise<ApiKeyAuth | null> {
  const key = supplied(req);
  if (!key) return null;
  if (process.env.AGENT_STUDIO_API_KEY && same(key, process.env.AGENT_STUDIO_API_KEY)) {
    return { tenantId: DEFAULT_TENANT_ID, keyId: null, name: 'AGENT_STUDIO_API_KEY', permissions: new Set(allPermissions()) };
  }
  if (!dbEnabled) return same(key, localApiKey()) ? { tenantId: DEFAULT_TENANT_ID, keyId: null, name: 'data/api-key', permissions: new Set(allPermissions()) } : null;
  const row = await findApiKeyByHash(sha(key));
  if (!row || row.revoked_at) return null;
  // last_used_at como mucho una vez por minuto por clave
  if (Date.now() - (lastTouch.get(row.id) ?? 0) > 60_000) {
    lastTouch.set(row.id, Date.now());
    void tenantDb(row.tenant_id).query('UPDATE api_keys SET last_used_at = NOW() WHERE tenant_id = :tenant AND id = ?', [row.id]).catch(() => {});
  }
  return { tenantId: row.tenant_id, keyId: row.id, name: row.name, permissions: expandScopes(parseJson<string[]>(row.scopes, [])) };
}
