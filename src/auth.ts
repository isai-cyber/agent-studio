// Usuarios e inicio de sesión con MariaDB.
// - Contraseñas con scrypt (sal aleatoria por usuario), nunca en claro.
// - Sesiones: token aleatorio en una cookie HttpOnly; en la base solo se guarda su SHA-256.
// - Bloqueo temporal tras varios intentos fallidos por email + IP.
// Se activa al definir DB_HOST (ver .env.example); sin él, la app funciona sin login.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, type ScryptOptions } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import mariadb from 'mariadb';

export const authEnabled = Boolean(process.env.DB_HOST);
const SIGNUP_OPEN = process.env.AUTH_ALLOW_SIGNUP !== 'false';
const COOKIE = 'as_session';
const SESSION_DAYS = 30;

export interface User { id: number; email: string; name: string; role: 'admin' | 'user'; created_at?: Date }

let pool: mariadb.Pool | null = null;
function db(): mariadb.Pool {
  pool ??= mariadb.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'agent_studio',
    connectionLimit: 5,
    bigIntAsNumber: true,
    insertIdAsNumber: true,
  });
  return pool;
}

export async function initAuth(): Promise<void> {
  if (!authEnabled) return;
  await db().query(`CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(190) NOT NULL UNIQUE,
    name VARCHAR(80) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin','user') NOT NULL DEFAULT 'user',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db().query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    user_agent VARCHAR(255) NULL,
    INDEX (user_id), INDEX (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
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

async function startSession(req: IncomingMessage, res: ServerResponse, userId: number) {
  const token = randomBytes(32).toString('base64url');
  await db().query('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?)',
    [sha(token), userId, SESSION_DAYS, String(req.headers['user-agent'] ?? '').slice(0, 255)]);
  await db().query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`);
}

export async function currentUser(req: IncomingMessage): Promise<User | null> {
  const token = cookieValue(req);
  if (!token) return null;
  const rows = await db().query('SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW()', [sha(token)]);
  return (rows[0] as User) ?? null;
}

// ---------- operaciones ----------
export async function register(req: IncomingMessage, res: ServerResponse, body: { name?: string; email?: string; password?: string }): Promise<User> {
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const [{ total }] = await db().query('SELECT COUNT(*) AS total FROM users');
  // Con el registro cerrado solo se puede crear la primera cuenta (la del administrador)
  if (!SIGNUP_OPEN && total > 0) throw fail(403, 'El registro de nuevas cuentas está desactivado. Pide acceso al administrador.');
  if (!name || name.length > 80) throw fail(400, 'Escribe tu nombre (máximo 80 caracteres).');
  if (!EMAIL.test(email)) throw fail(400, 'El email no es válido.');
  if (password.length < 8 || password.length > 200) throw fail(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (password.toLowerCase().includes(email.split('@')[0]) && email.split('@')[0].length >= 4) throw fail(400, 'La contraseña no debe contener tu email.');
  const role = total === 0 ? 'admin' : 'user';
  try {
    const r = await db().query('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)', [email, name, await hashPassword(password), role]);
    await startSession(req, res, r.insertId);
    return { id: r.insertId, email, name, role };
  } catch (e) {
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw fail(409, 'Ya existe una cuenta con ese email. Inicia sesión.');
    throw e;
  }
}

export async function login(req: IncomingMessage, res: ServerResponse, body: { email?: string; password?: string }): Promise<User> {
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const key = `${email}|${req.socket.remoteAddress ?? ''}`;
  checkLock(key);
  const rows = await db().query('SELECT id, email, name, role, password_hash FROM users WHERE email = ?', [email]);
  const row = rows[0] as (User & { password_hash: string }) | undefined;
  const ok = row ? await verifyPassword(password, row.password_hash) : (await verifyPassword(password, await DUMMY), false);
  if (!row || !ok) { noteFail(key); throw fail(401, 'Email o contraseña incorrectos.'); }
  attempts.delete(key);
  await startSession(req, res, row.id);
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = cookieValue(req);
  if (token) await db().query('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure(req) ? '; Secure' : ''}`);
}

export async function authInfo() {
  if (!authEnabled) return { enabled: false, signup: false, firstUser: false };
  const [{ total }] = await db().query('SELECT COUNT(*) AS total FROM users');
  return { enabled: true, signup: SIGNUP_OPEN || total === 0, firstUser: total === 0 };
}

// Peticiones que cambian datos desde otra web: se rechazan (además de SameSite=Lax)
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || req.method === 'GET' || req.method === 'HEAD') return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
