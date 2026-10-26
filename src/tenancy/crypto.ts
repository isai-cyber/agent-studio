// Cifrado de credenciales (no desactivable): AES-256-GCM con una clave maestra
// (ENCRYPTION_KEY en .env) y una clave derivada por empresa con HKDF. Un texto
// cifrado de una empresa no se puede descifrar con la clave de otra, y el
// "contexto" (p. ej. la app) va como dato autenticado: no se pueden intercambiar
// valores entre apps.
//
// Formato: v1:<iv>:<tag>:<datos>, todo en base64url.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, assertTenant } from './paths.ts';

let master: Buffer | null = null;
const derived = new Map<number, Buffer>();

function parseKey(raw: string): Buffer {
  const s = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY debe tener 32 bytes (64 caracteres hex o 44 en base64). Genera una con: openssl rand -base64 32');
  return buf;
}

// Sin ENCRYPTION_KEY se genera una en data/encryption-key (0600) para no guardar
// nada en claro, pero lo recomendable es ponerla en el .env y guardarla aparte.
export function masterKey(): Buffer {
  if (master) return master;
  if (process.env.ENCRYPTION_KEY) return (master = parseKey(process.env.ENCRYPTION_KEY));
  const file = join(DATA_DIR, 'encryption-key');
  if (!existsSync(file)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.warn(`⚠ Falta ENCRYPTION_KEY: se generó una en ${file}. Cópiala al .env y guárdala en lugar seguro.`);
  }
  return (master = parseKey(readFileSync(file, 'utf8')));
}

export function tenantKey(tenantId: number): Buffer {
  assertTenant(tenantId);
  let k = derived.get(tenantId);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', masterKey(), Buffer.from(`agent-studio:tenant:${tenantId}`), Buffer.from('credentials:v1'), 32));
    derived.set(tenantId, k);
  }
  return k;
}

const aad = (tenantId: number, context: string) => Buffer.from(`${tenantId}|${context}`);

export function encrypt(tenantId: number, context: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', tenantKey(tenantId), iv);
  c.setAAD(aad(tenantId, context));
  const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
}

export function decrypt(tenantId: number, context: string, payload: string): string {
  const [v, iv, tag, data] = String(payload).split(':');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Credencial cifrada con un formato desconocido');
  const d = createDecipheriv('aes-256-gcm', tenantKey(tenantId), Buffer.from(iv, 'base64url'));
  d.setAAD(aad(tenantId, context));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

export const isEncrypted = (v: unknown) => typeof v === 'string' && v.startsWith('v1:');

// Solo para las pruebas
export function resetKeyCache(): void {
  master = null;
  derived.clear();
}
