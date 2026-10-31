// Usuarios e inicio de sesión con MariaDB.
// - Contraseñas con scrypt (sal aleatoria por usuario), nunca en claro.
// - Sesiones: token aleatorio en una cookie HttpOnly; en la base solo se guarda su SHA-256.
// - Bloqueo temporal tras varios intentos fallidos por email + IP.
// - Cada sesión recuerda su empresa activa (sessions.active_tenant_id).
// - Los inicios de sesión quedan en la auditoría.
// Se activa al definir DB_HOST (ver .env.example); sin él, la app funciona sin login.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, type ScryptOptions } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, dbEnabled } from './db/pool.ts';
import { runMigrations } from './db/migrations.ts';
import { tenantDb } from './db/tenant-db.ts';
import { audit } from './tenancy/audit.ts';
import { systemRoleId, membershipsOfUser } from './tenancy/platform.ts';
import { acceptInvitation, invitationInfo } from './tenancy/members.ts';
import { createTenant, listPlans } from './tenancy/tenants.ts';
import { DEFAULT_TENANT_ID } from './tenancy/paths.ts';
import type { SessionUser } from './authz/context.ts';

export const authEnabled = dbEnabled;
const SIGNUP_OPEN = process.env.AUTH_ALLOW_SIGNUP !== 'false';
// true = quien se registra sin invitación crea su propia empresa (modo SaaS)
const SELF_SIGNUP = process.env.TENANT_SELF_SIGNUP === 'true';
const COOKIE = 'as_session';
const SESSION_DAYS = 30;

export interface User extends SessionUser { role?: 'admin' | 'user' }

const ipOf = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || null;
const toUser = (r: any): User => ({ id: r.id, email: r.email, name: r.name, role: r.role, isPlatformAdmin: Boolean(r.is_platform_admin) });

export async function initAuth(): Promise<void> {
  if (!authEnabled) return;
  await runMigrations((m) => console.log(m));
  await db().query('DELETE FROM sessions WHERE expires_at < NOW()');
}

// ---------- contraseñas ----------
const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((ok, ko) => scryptCb(pw, salt, len, opts, (e, k) => (e ? ko(e) : ok(k))));
const N = 16384, R = 8, P = 1, LEN = 64;

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(key, expected);
}
// Para que un email inexistente tarde lo mismo que una contraseña errónea
const DUMMY = hashPassword('x'.repeat(16));

// ---------- validación y bloqueo ----------
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,180}\.[^\s@]{2,}$/;

const attempts = new Map<string, { n: number; until: number; first: number }>();
const WINDOW = 15 * 60_000, MAX_FAILS = 8;
function checkLock(key: string) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) throw fail(429, `Demasiados intentos. Prueba de nuevo en ${Math.ceil((a.until - Date.now()) / 60_000)} min.`);
}
function noteFail(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  const cur = a && now - a.first < WINDOW ? a : { n: 0, until: 0, first: now };
  cur.n++;
  if (cur.n >= MAX_FAILS) cur.until = now + WINDOW;
  attempts.set(key, cur);
}

// ---------- sesiones ----------
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function cookieValue(req: IncomingMessage): string | null {
  const m = String(req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
  return m ? m[1] : null;
}
const secure = (req: IncomingMessage) => process.env.COOKIE_SECURE === 'true' || req.headers['x-forwarded-proto'] === 'https';

async function startSession(req: IncomingMessage, res: ServerResponse, userId: number, tenantId: number | null) {
  const token = randomBytes(32).toString('base64url');
  await db().query('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, active_tenant_id) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?)',
    [sha(token), userId, SESSION_DAYS, String(req.headers['user-agent'] ?? '').slice(0, 255), tenantId]);
  await db().query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`);
}

export interface CurrentSession { user: User; tokenHash: string; activeTenantId: number | null }

export async function currentSession(req: IncomingMessage): Promise<CurrentSession | null> {
  const token = cookieValue(req);
  if (!token) return null;
  const rows = await db().query('SELECT u.id, u.email, u.name, u.role, u.is_platform_admin, s.active_tenant_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW()', [sha(token)]);
  return rows[0] ? { user: toUser(rows[0]), tokenHash: sha(token), activeTenantId: rows[0].active_tenant_id ?? null } : null;
}

export async function currentUser(req: IncomingMessage): Promise<User | null> {
  return (await currentSession(req))?.user ?? null;
}

export async function setActiveTenant(tokenHash: string, tenantId: number | null): Promise<void> {
  await db().query('UPDATE sessions SET active_tenant_id = ? WHERE token_hash = ?', [tenantId, tokenHash]);
}

// Primera empresa activa del usuario (para abrir la sesión en ella)
async function firstTenant(userId: number): Promise<number | null> {
  return (await membershipsOfUser(userId)).find((m) => m.status === 'active' && m.tenantStatus === 'active')?.tenantId ?? null;
}

// ---------- operaciones ----------
export async function register(req: IncomingMessage, res: ServerResponse, body: { name?: string; email?: string; password?: string; invitation?: string; company?: string }): Promise<User> {
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const invitation = body.invitation ? String(body.invitation) : '';
  const invited = invitation ? await invitationInfo(invitation) : null;
  if (invitation && !invited) throw fail(410, 'La invitación no existe o caducó. Pide una nueva.');
  if (invited && invited.email !== email) throw fail(403, `Esta invitación es para ${invited.email}.`);
  const [{ total }] = await db().query('SELECT COUNT(*) AS total FROM users');
  // Con el registro cerrado solo se puede crear la primera cuenta (la del administrador) o aceptar una invitación
  if (!SIGNUP_OPEN && total > 0 && !invited) throw fail(403, 'El registro de nuevas cuentas está desactivado. Pide una invitación al administrador de tu empresa.');
  if (!name || name.length > 80) throw fail(400, 'Escribe tu nombre (máximo 80 caracteres).');
  if (!EMAIL.test(email)) throw fail(400, 'El email no es válido.');
  if (password.length < 8 || password.length > 200) throw fail(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (password.toLowerCase().includes(email.split('@')[0]) && email.split('@')[0].length >= 4) throw fail(400, 'La contraseña no debe contener tu email.');
  const first = total === 0;
  let userId: number;
  try {
    const r = await db().query('INSERT INTO users (email, name, password_hash, role, is_platform_admin) VALUES (?, ?, ?, ?, ?)', [email, name, await hashPassword(password), first ? 'admin' : 'user', first ? 1 : 0]);
    userId = r.insertId;
  } catch (e) {
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw fail(409, 'Ya existe una cuenta con ese email. Inicia sesión.');
    throw e;
  }
  let tenantId: number | null = null;
  if (first) {
    // La primera cuenta es Propietaria de Default y superadmin de la plataforma
    await tenantDb(DEFAULT_TENANT_ID).query('INSERT IGNORE INTO memberships (user_id, tenant_id, role_id) VALUES (?, :tenant, ?)', [userId, await systemRoleId('owner')]);
    tenantId = DEFAULT_TENANT_ID;
  } else if (invited) {
    tenantId = (await acceptInvitation(invitation, { id: userId, email })).tenantId;
  } else if (SELF_SIGNUP) {
    const plans = await listPlans();
    const plan = plans.find((p) => p.key === (process.env.TENANT_SIGNUP_PLAN ?? 'basico')) ?? plans[0];
    const t = await createTenant({ name: String(body.company ?? '').trim() || `Empresa de ${name}`, planId: plan.id });
    await tenantDb(t.id).query('INSERT INTO memberships (user_id, tenant_id, role_id) VALUES (?, :tenant, ?)', [userId, await systemRoleId('owner')]);
    await audit({ tenantId: t.id, actor: { type: 'user', userId }, ip: ipOf(req), action: 'tenant.created', target: `tenant:${t.id}`, after: { name: t.name, slug: t.slug, plan: plan.key, selfSignup: true } });
    tenantId = t.id;
  }
  await startSession(req, res, userId, tenantId);
  await audit({ tenantId, actor: { type: 'user', userId }, ip: ipOf(req), action: 'auth.register', target: `user:${userId}`, after: { email, invited: Boolean(invited) } });
  return { id: userId, email, name, role: first ? 'admin' : 'user', isPlatformAdmin: first };
}

export async function login(req: IncomingMessage, res: ServerResponse, body: { email?: string; password?: string; invitation?: string }): Promise<User> {
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const key = `${email}|${req.socket.remoteAddress ?? ''}`;
  checkLock(key);
  const rows = await db().query('SELECT id, email, name, role, is_platform_admin, password_hash FROM users WHERE email = ?', [email]);
  const row = rows[0] as (User & { password_hash: string; is_platform_admin: number }) | undefined;
  const ok = row ? await verifyPassword(password, row.password_hash) : (await verifyPassword(password, await DUMMY), false);
  if (!row || !ok) {
    noteFail(key);
    await audit({ tenantId: null, actor: { type: 'system' }, ip: ipOf(req), action: 'auth.login_failed', target: `email:${email.slice(0, 180)}` });
    throw fail(401, 'Email o contraseña incorrectos.');
  }
  attempts.delete(key);
  // Entrar con un enlace de invitación la acepta
  const tenantId = body.invitation ? (await acceptInvitation(String(body.invitation), { id: row.id, email: row.email })).tenantId : await firstTenant(row.id);
  await startSession(req, res, row.id, tenantId);
  await audit({ tenantId, actor: { type: 'user', userId: row.id }, ip: ipOf(req), action: 'auth.login', target: `user:${row.id}` });
  return toUser(row);
}

export async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = cookieValue(req);
  if (token) await db().query('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure(req) ? '; Secure' : ''}`);
}

export async function authInfo(invitation?: string | null) {
  if (!authEnabled) return { enabled: false, signup: false, firstUser: false };
  const [{ total }] = await db().query('SELECT COUNT(*) AS total FROM users');
  const invited = invitation ? await invitationInfo(invitation) : null;
  return { enabled: true, signup: SIGNUP_OPEN || total === 0 || Boolean(invited), firstUser: total === 0, selfSignup: SELF_SIGNUP, invitation: invited };
}

// Peticiones que cambian datos desde otra web: se rechazan (además de SameSite=Lax)
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || req.method === 'GET' || req.method === 'HEAD') return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
