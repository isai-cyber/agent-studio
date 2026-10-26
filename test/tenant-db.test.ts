// El tenant_id es obligatorio en toda consulta a tablas de empresa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setupEnv } from './_helpers.ts';

await setupEnv('tenantdb');
const { bindTenant, tenantDb, TENANT_TABLES } = await import('../src/db/tenant-db.ts');

test('tenantDb rechaza consultas sin :tenant', async () => {
  const t = tenantDb(1);
  await assert.rejects(t.query('SELECT * FROM api_keys'), /sin tenant_id/);
  await assert.rejects(t.query('SELECT * FROM api_keys WHERE id = ?', [1]), /sin tenant_id/);
  assert.throws(() => tenantDb(0), /empresa/);
});

test('bindTenant sustituye :tenant en orden', () => {
  const b = bindTenant(7, 'UPDATE api_keys SET name = ? WHERE tenant_id = :tenant AND id = ?', ['x', 3]);
  assert.equal(b.sql, 'UPDATE api_keys SET name = ? WHERE tenant_id = ? AND id = ?');
  assert.deepEqual(b.params, ['x', 7, 3]);
  assert.throws(() => bindTenant(7, 'SELECT 1 WHERE tenant_id = :tenant AND id = ?', []), /Faltan/);
  assert.throws(() => bindTenant(7, 'SELECT 1 WHERE tenant_id = :tenant', [1]), /Sobran/);
});

// Lee el código: ninguna consulta a una tabla de empresa puede escribirse fuera del
// helper (es decir, sin el marcador :tenant), salvo en los archivos de plataforma.
const ALLOWED = new Set(['src/db/migrations.ts', 'src/tenancy/platform.ts', 'src/db/tenant-db.ts']);
const ROOT = join(import.meta.dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('ninguna consulta de empresa omite el tenant_id', () => {
  const tables = new RegExp(`\\b(${TENANT_TABLES.join('|')})\\b`);
  const sqlKw = /\b(SELECT|INSERT\s+(IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\b/i;
  const offenders: string[] = [];
  for (const file of files(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file);
    if (ALLOWED.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
      const lit = m[2];
      if (sqlKw.test(lit) && tables.test(lit) && !/:tenant\b/.test(lit)) {
        offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length} → ${lit.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Consultas sin tenant_id:\n${offenders.join('\n')}`);
});
