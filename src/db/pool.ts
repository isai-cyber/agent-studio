// Pool de MariaDB compartido por usuarios, empresas, permisos y auditoría.
// Se activa al definir DB_HOST (ver .env.example); sin él, la app funciona sin login.
import mariadb from 'mariadb';

export const dbEnabled = Boolean(process.env.DB_HOST);

let pool: mariadb.Pool | null = null;

export function db(): mariadb.Pool {
  if (!dbEnabled) throw Object.assign(new Error('Esta función necesita MariaDB (define DB_HOST en .env)'), { status: 501 });
  pool ??= mariadb.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'agent_studio',
    connectionLimit: Number(process.env.DB_POOL_SIZE ?? 5),
    bigIntAsNumber: true,
    insertIdAsNumber: true,
    decimalAsNumber: true,
  });
  return pool;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}

// Ejecuta fn dentro de una transacción
export async function tx<T>(fn: (conn: mariadb.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Las columnas JSON de MariaDB llegan como texto
export function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}
