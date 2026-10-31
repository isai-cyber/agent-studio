// Migración de una instalación de una sola empresa a multi-tenant
// (`npm run migrate:tenancy`). Es repetible: cada paso comprueba si ya se hizo.
//
//  1. Aplica las migraciones de MariaDB (si hay DB_HOST).
//  2. Crea la empresa "Default" (id 1) si no existe.
//  3. El administrador actual pasa a Propietario de Default y superadmin; el
//     resto de cuentas, a Admin de Default (antes veían todo).
//  4. Respalda data/ y los agentes antes de mover nada (data/backups/tenancy-<fecha>/).
//  5. Mueve data/{metrics,flows,files} a data/tenants/1/ y agents/<id>/ a agents/1/<id>/.
//  6. Cifra data/connections.json en data/tenants/1/connections.json y borra el original.
//  7. La clave global data/api-key pasa a ser una clave de API de Default (con todos los permisos).
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AGENTS_BASE, DATA_DIR, DEFAULT_TENANT_ID, TENANTS_DIR, tenantAgentsPath, tenantDataPath } from './paths.ts';
import { encrypt } from './crypto.ts';
import { dbEnabled, db } from '../db/pool.ts';
import { tenantDb } from '../db/tenant-db.ts';
import { systemRoleId } from './platform.ts';
import { runMigrations } from '../db/migrations.ts';

export interface TenancyReport { steps: string[]; warnings: string[]; backup?: string; moved: number }

const exists = (p: string) => existsSync(p);

// Agentes en el formato antiguo: agents/<id>/agent.yaml (sin carpeta de empresa)
export async function legacyAgentDirs(): Promise<string[]> {
  if (!exists(AGENTS_BASE)) return [];
  const out: string[] = [];
  for (const e of await readdir(AGENTS_BASE, { withFileTypes: true })) {
    if (e.isDirectory() && exists(join(AGENTS_BASE, e.name, 'agent.yaml'))) out.push(e.name);
  }
  return out;
}

const LEGACY_DATA = ['connections.json', 'metrics', 'flows', 'files', 'api-key'];

export async function needsTenancyMigration(): Promise<boolean> {
  if (LEGACY_DATA.filter((f) => f !== 'api-key').some((f) => exists(join(DATA_DIR, f)))) return true;
  if (dbEnabled && exists(join(DATA_DIR, 'api-key'))) return true;
  return (await legacyAgentDirs()).length > 0;
}

// Mueve src a dst; si dst ya existe, fusiona: los .jsonl se concatenan y el
// resto de archivos que ya existen en el destino se dejan (y se avisa).
async function moveMerge(src: string, dst: string, r: TenancyReport): Promise<void> {
  if (!exists(src)) return;
  if (!exists(dst)) {
    await mkdir(join(dst, '..'), { recursive: true });
    await rename(src, dst);
    r.moved++;
    return;
  }
  if ((await stat(src)).isDirectory()) {
    for (const e of await readdir(src)) await moveMerge(join(src, e), join(dst, e), r);
    await rmdir(src).catch(() => r.warnings.push(`No se pudo vaciar ${src}: revisa los archivos que quedaron (ya existían en el destino).`));
    return;
  }
  if (src.endsWith('.jsonl')) {
    await appendFile(dst, await readFile(src));
    await rm(src);
    r.moved++;
    return;
  }
  r.warnings.push(`${dst} ya existe: se conserva y ${src} se deja sin mover.`);
}

async function backup(r: TenancyReport, agents: string[]): Promise<void> {
  const dir = join(DATA_DIR, 'backups', `tenancy-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dir, { recursive: true });
  for (const f of LEGACY_DATA) if (exists(join(DATA_DIR, f))) await cp(join(DATA_DIR, f), join(dir, 'data', f), { recursive: true, preserveTimestamps: true });
  for (const a of agents) await cp(join(AGENTS_BASE, a), join(dir, 'agents', a), { recursive: true, preserveTimestamps: true });
  r.backup = dir;
  r.steps.push(`Respaldo en ${dir}`);
}

async function migrateConnections(r: TenancyReport): Promise<void> {
  const legacy = join(DATA_DIR, 'connections.json');
  if (!exists(legacy)) return;
  let plain: Record<string, Record<string, string>> = {};
  try { plain = JSON.parse(await readFile(legacy, 'utf8')); } catch { r.warnings.push('data/connections.json no es JSON válido: no se migró.'); return; }
  const target = tenantDataPath(DEFAULT_TENANT_ID, 'connections.json');
  let store: { version: 1; apps: Record<string, string> } = { version: 1, apps: {} };
  if (exists(target)) store = JSON.parse(await readFile(target, 'utf8'));
  let n = 0;
  for (const [app, fields] of Object.entries(plain)) {
    if (store.apps[app]) { r.warnings.push(`La conexión "${app}" ya existía cifrada: se conserva la cifrada.`); continue; }
    store.apps[app] = encrypt(DEFAULT_TENANT_ID, `connection:${app}`, JSON.stringify(fields));
    n++;
  }
  await mkdir(tenantDataPath(DEFAULT_TENANT_ID), { recursive: true });
  await writeFile(target, JSON.stringify(store, null, 2), { mode: 0o600 });
  await rm(legacy);
  r.steps.push(`Conexiones cifradas: ${n} (data/connections.json eliminado; hay copia en el respaldo)`);
}

async function migrateApiKey(r: TenancyReport): Promise<void> {
  const file = join(DATA_DIR, 'api-key');
  if (!exists(file) || !dbEnabled) return;
  const key = (await readFile(file, 'utf8')).trim();
  if (key) {
    const hash = createHash('sha256').update(key).digest('hex');
    await tenantDb(DEFAULT_TENANT_ID).query(
      "INSERT IGNORE INTO api_keys (tenant_id, name, key_hash, prefix, scopes) VALUES (:tenant, 'Clave global migrada', ?, ?, '[\"*\"]')",
      [hash, key.slice(0, 10)],
    );
    r.steps.push('La clave global (data/api-key) es ahora una clave de API de la empresa Default con todos los permisos');
  }
  await rm(file);
}

async function migrateUsers(r: TenancyReport): Promise<void> {
  // Solo la primera vez: si Default ya tiene miembros, no se toca nada
  const t = tenantDb(DEFAULT_TENANT_ID);
  const [{ n }] = await t.query('SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = :tenant');
  if (n > 0) return;
  const users = (await db().query("SELECT id, email, role FROM users ORDER BY (role = 'admin') DESC, id ASC")) as { id: number; email: string; role: string }[];
  if (!users.length) { r.steps.push('No hay usuarios todavía: la primera cuenta que se registre será Propietaria de Default y superadmin'); return; }
  const owner = await systemRoleId('owner');
  const admin = await systemRoleId('admin');
  const [first, ...rest] = users;
  await db().query('UPDATE users SET is_platform_admin = 1 WHERE id = ?', [first.id]);
  await t.query('INSERT IGNORE INTO memberships (user_id, tenant_id, role_id) VALUES (?, :tenant, ?)', [first.id, owner]);
  for (const u of rest) await t.query('INSERT IGNORE INTO memberships (user_id, tenant_id, role_id) VALUES (?, :tenant, ?)', [u.id, admin]);
  await db().query('UPDATE sessions SET active_tenant_id = ? WHERE active_tenant_id IS NULL', [DEFAULT_TENANT_ID]);
  await t.query(
    "INSERT INTO audit_log (tenant_id, actor_type, action, target, `after`) VALUES (:tenant, 'system', 'tenancy.migrated', ?, ?)",
    [`user:${first.id}`, JSON.stringify({ owner: first.email, admins: rest.map((u) => u.email) })],
  );
  r.steps.push(`${first.email} es Propietario de Default y superadmin${rest.length ? `; ${rest.length} cuenta(s) más pasan a Admin de Default` : ''}`);
}

export async function migrateTenancy(log: (m: string) => void = console.log): Promise<TenancyReport> {
  const r: TenancyReport = { steps: [], warnings: [], moved: 0 };
  if (dbEnabled) {
    const m = await runMigrations(log);
    r.steps.push(m.applied.length ? `Base de datos: ${m.applied.length} migración(es) aplicada(s), versión ${m.current}` : `Base de datos al día (versión ${m.current})`);
    for (const a of m.applied) if (a.warning) r.warnings.push(a.warning);
    await migrateUsers(r);
  } else {
    r.warnings.push('Sin DB_HOST: solo se migran los archivos. Las empresas, usuarios y permisos necesitan MariaDB.');
  }

  const agents = await legacyAgentDirs();
  if (await needsTenancyMigration()) {
    await backup(r, agents);
    await mkdir(TENANTS_DIR, { recursive: true });
    await migrateConnections(r);
    for (const d of ['metrics', 'flows', 'files']) await moveMerge(join(DATA_DIR, d), tenantDataPath(DEFAULT_TENANT_ID, d), r);
    for (const a of agents) await moveMerge(join(AGENTS_BASE, a), tenantAgentsPath(DEFAULT_TENANT_ID, a), r);
    if (agents.length) r.steps.push(`Agentes movidos a agents/${DEFAULT_TENANT_ID}/: ${agents.length}`);
    await migrateApiKey(r);
  } else {
    r.steps.push('Archivos ya migrados: no hay nada que mover');
  }
  await mkdir(tenantDataPath(DEFAULT_TENANT_ID), { recursive: true });
  await mkdir(tenantAgentsPath(DEFAULT_TENANT_ID), { recursive: true });
  return r;
}
