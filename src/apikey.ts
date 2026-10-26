// Clave de API para la API REST pública (/v1) y el servidor MCP (/mcp).
// Se genera la primera vez en data/api-key; AGENT_STUDIO_API_KEY la sustituye.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ROOT } from './store.ts';

const FILE = join(ROOT, 'data', 'api-key');
let cached: string | undefined;

export function getApiKey(): string {
  if (process.env.AGENT_STUDIO_API_KEY) return process.env.AGENT_STUDIO_API_KEY;
  if (cached) return cached;
  if (existsSync(FILE)) {
    cached = readFileSync(FILE, 'utf8').trim();
    if (cached) return cached;
  }
  cached = `as_${randomBytes(24).toString('base64url')}`;
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(FILE, `${cached}\n`, { mode: 0o600 });
  chmodSync(FILE, 0o600);
  return cached;
}

export function rotateApiKey(): string {
  cached = undefined;
  writeFileSync(FILE, '', { mode: 0o600 });
  return getApiKey();
}

// Acepta "Authorization: Bearer <clave>" o "x-api-key: <clave>"
export function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  const supplied = (typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7) : req.headers['x-api-key']) ?? '';
  if (typeof supplied !== 'string' || !supplied) return false;
  const a = Buffer.from(supplied.trim());
  const b = Buffer.from(getApiKey());
  return a.length === b.length && timingSafeEqual(a, b);
}
