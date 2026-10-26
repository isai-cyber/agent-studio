// Migración de una instalación existente (una sola empresa) a multi-tenant.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setupEnv, dbAvailable, rawDb } from './_helpers.ts';

const hasDb = await dbAvailable();
if (!hasDb) console.warn('⚠ Sin MariaDB de pruebas: se omiten las pruebas de migración con base de datos');
const env = await setupEnv('migration', { db: hasDb });
const SECRET = 'xoxb-super-secreto-123';
const LEGACY_KEY = 'as_claveGlobalAntigua0123456789abcdef';

before(async () => {
  // Instalación "antigua": esquema de users/sessions sin empresas
  if (hasDb) {
    const c = await rawDb(env.dbName!);
    await c.query(`CREATE TABLE users (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190) NOT NULL UNIQUE, name VARCHAR(80) NOT NULL,
      password_hash VARCHAR(255) NOT NULL, role ENUM('admin','user') NOT NULL DEFAULT 'user', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TIMESTAMP NULL)`);
    await c.query(`CREATE TABLE sessions (token_hash CHAR(64) PRIMARY KEY, user_id INT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL, user_agent VARCHAR(255) NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
    await c.query("INSERT INTO users (email, name, password_hash, role) VALUES ('ana@x.com', 'Ana', 'h', 'admin'), ('beto@x.com', 'Beto', 'h', 'user')");
    await c.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (REPEAT('a', 64), 1, DATE_ADD(NOW(), INTERVAL 1 DAY))");
    await c.end();
  }
  const d = env.dataDir;
  await writeFile(join(d, 'connections.json'), JSON.stringify({ slack: { token: SECRET }, jira: { site: 'x.atlassian.net', token: 't0k3n-jira' } }));
  await mkdir(join(d, 'metrics'), { recursive: true });
  await writeFile(join(d, 'metrics', 'events.jsonl'), '{"type":"turn","agentId":"demo"}\n');
  await mkdir(join(d, 'flows', 'runs'), { recursive: true });
  await writeFile(join(d, 'flows', 'abc12345.json'), JSON.stringify({ id: 'abc12345', name: 'Flujo', active: true, trigger: null, steps: [] }));
  await writeFile(join(d, 'flows', 'runs', 'abc12345.jsonl'), '{"id":"r1"}\n');
  await writeFile(join(d, 'flows', 'state.json'), '{}');
  await mkdir(join(d, 'files'), { recursive: true });
  await writeFile(join(d, 'files', 'audio.mp3'), 'mp3');
  await writeFile(join(d, 'api-key'), `${LEGACY_KEY}\n`);
  await mkdir(join(env.agentsDir, 'demo', 'knowledge'), { recursive: true });
  await writeFile(join(env.agentsDir, 'demo', 'agent.yaml'), 'name: Demo\ninstructions: Hola\n');
  await writeFile(join(env.agentsDir, 'demo', 'knowledge', 'faq.md'), '# FAQ');
});

after(async () => {
  if (hasDb) await (await import('../src/db/pool.ts')).closeDb();
});

test('migra archivos, cifra conexiones y asigna la empresa Default', async () => {
  const { migrateTenancy } = await import('../src/tenancy/migrate.ts');
  const r = await migrateTenancy(() => {});
  const t1 = join(env.dataDir, 'tenants', '1');

  // Respaldo previo con los originales
  assert.ok(r.backup && existsSync(join(r.backup, 'data', 'connections.json')));
  assert.ok(existsSync(join(r.backup!, 'agents', 'demo', 'agent.yaml')));

  // Archivos movidos
  assert.ok(existsSync(join(t1, 'metrics', 'events.jsonl')));
  assert.ok(existsSync(join(t1, 'flows', 'abc12345.json')));
  assert.ok(existsSync(join(t1, 'flows', 'runs', 'abc12345.jsonl')));
  assert.ok(existsSync(join(t1, 'files', 'audio.mp3')));
  assert.ok(existsSync(join(env.agentsDir, '1', 'demo', 'knowledge', 'faq.md')));
  for (const old of ['connections.json', 'metrics', 'flows', 'files']) assert.ok(!existsSync(join(env.dataDir, old)), `${old} debería haberse movido`);
  assert.ok(!existsSync(join(env.agentsDir, 'demo')));

  // Conexiones cifradas: sin secretos en claro
  const conn = await readFile(join(t1, 'connections.json'), 'utf8');
  assert.ok(!conn.includes(SECRET) && !conn.includes('t0k3n-jira') && !conn.includes('atlassian'));
  assert.match(conn, /"slack": "v1:/);

  if (hasDb) {
    const c = await rawDb(env.dbName!);
    const [tenant] = await c.query('SELECT * FROM tenants WHERE id = 1');
    assert.equal(tenant.slug, 'default');
    const members = await c.query('SELECT u.email, r.system_key, u.is_platform_admin FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id ORDER BY u.id');
    assert.deepEqual(members.map((m: any) => [m.email, m.system_key, m.is_platform_admin]), [['ana@x.com', 'owner', 1], ['beto@x.com', 'admin', 0]]);
    const [s] = await c.query('SELECT active_tenant_id FROM sessions');
    assert.equal(s.active_tenant_id, 1);
    const keys = await c.query('SELECT * FROM api_keys WHERE tenant_id = 1');
    assert.equal(keys.length, 1);
    assert.equal(keys[0].key_hash, createHash('sha256').update(LEGACY_KEY).digest('hex'));
    assert.deepEqual(typeof keys[0].scopes === "string" ? JSON.parse(keys[0].scopes) : keys[0].scopes, ["*"]);
    assert.ok(!existsSync(join(env.dataDir, 'api-key')));
    const audit = await c.query("SELECT * FROM audit_log WHERE action = 'tenancy.migrated'");
    assert.equal(audit.length, 1);
    await c.end();
  }
});

test('es repetible: la segunda vez no mueve ni respalda nada', async () => {
  const { migrateTenancy } = await import('../src/tenancy/migrate.ts');
  const backups = await readdir(join(env.dataDir, 'backups'));
  const r = await migrateTenancy(() => {});
  assert.equal(r.backup, undefined);
  assert.equal(r.moved, 0);
  assert.deepEqual(await readdir(join(env.dataDir, 'backups')), backups);
  if (hasDb) {
    const c = await rawDb(env.dbName!);
    const [{ n }] = await c.query('SELECT COUNT(*) AS n FROM memberships');
    assert.equal(n, 2);
    const [{ v }] = await c.query('SELECT MAX(version) AS v FROM schema_migrations');
    assert.ok(v >= 4);
    await c.end();
  }
});

test('la auditoría no se puede modificar ni borrar', { skip: !hasDb }, async () => {
  const c = await rawDb(env.dbName!);
  await assert.rejects(c.query("UPDATE audit_log SET action = 'x'"), /solo lectura/);
  await assert.rejects(c.query('DELETE FROM audit_log'), /solo lectura/);
  await c.end();
});
