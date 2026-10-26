// Utilidades de las pruebas. Cada archivo de prueba corre en su propio proceso
// (node --test), así que la configuración por variables de entorno se fija aquí
// ANTES de importar el código de la app (con import() dinámico).
//
// Las pruebas con base de datos usan MariaDB (por defecto agent_studio:test@127.0.0.1)
// y una base propia por archivo que se borra y se crea de nuevo. Variables:
//   TEST_DB_HOST, TEST_DB_PORT, TEST_DB_USER, TEST_DB_PASSWORD
// Si no hay MariaDB disponible, esas pruebas se omiten (se avisa).
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mariadb from 'mariadb';

export interface TestEnv { dataDir: string; agentsDir: string; dbName: string | null }

const DB = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 3306),
  user: process.env.TEST_DB_USER ?? 'agent_studio',
  password: process.env.TEST_DB_PASSWORD ?? 'test',
};

export async function dbAvailable(): Promise<boolean> {
  try {
    const c = await mariadb.createConnection({ ...DB, connectTimeout: 2000 });
    await c.end();
    return true;
  } catch {
    return false;
  }
}

// Prepara carpetas temporales y (opcionalmente) una base de datos vacía
export async function setupEnv(name: string, opts: { db?: boolean } = {}): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), `as-test-${name}-`));
  const dataDir = join(root, 'data');
  const agentsDir = join(root, 'agents');
  await mkdir(dataDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  process.env.AGENT_STUDIO_DATA_DIR = dataDir;
  process.env.AGENT_STUDIO_AGENTS_DIR = agentsDir;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.PERMISSION_CACHE_TTL_MS = '50';
  process.env.AUTH_ALLOW_SIGNUP = 'true';
  delete process.env.AGENT_STUDIO_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
  let dbName: string | null = null;
  if (opts.db) {
    dbName = `as_test_${name.replace(/[^a-z0-9]/gi, '_')}`;
    const c = await mariadb.createConnection(DB);
    await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await c.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4`);
    await c.end();
    process.env.DB_HOST = DB.host;
    process.env.DB_PORT = String(DB.port);
    process.env.DB_USER = DB.user;
    process.env.DB_PASSWORD = DB.password;
    process.env.DB_NAME = dbName;
  } else {
    delete process.env.DB_HOST;
  }
  return { dataDir, agentsDir, dbName };
}

// Conexión directa a la base de prueba (para preparar datos "antiguos" o comprobar tablas)
export async function rawDb(dbName: string): Promise<mariadb.Connection> {
  return mariadb.createConnection({ ...DB, database: dbName, bigIntAsNumber: true, insertIdAsNumber: true });
}
