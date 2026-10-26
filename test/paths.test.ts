import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './_helpers.ts';

const env = await setupEnv('paths');
const { tenantDataPath, tenantAgentsPath, safeJoin } = await import('../src/tenancy/paths.ts');

test('las rutas de empresa quedan dentro de su carpeta', () => {
  assert.equal(tenantDataPath(3, 'flows', 'abc.json'), `${env.dataDir}/tenants/3/flows/abc.json`);
  assert.equal(tenantAgentsPath(3, 'soporte'), `${env.agentsDir}/3/soporte`);
});

test('se rechaza el path traversal', () => {
  for (const bad of ['..', '../2', '..%2f', 'a/../../b', '/etc/passwd', 'a/b', '.hidden', '', 'a\\..\\b', 'x\0y']) {
    assert.throws(() => tenantDataPath(1, bad), /Ruta no válida|fuera/, `debería rechazar ${JSON.stringify(bad)}`);
    assert.throws(() => tenantAgentsPath(1, bad), /Ruta no válida|fuera/);
  }
  assert.throws(() => safeJoin('/srv/base', '..', 'otra'));
});

test('el id de empresa debe ser un entero positivo', () => {
  for (const bad of [0, -1, 1.5, NaN, '1' as unknown as number, undefined as unknown as number]) {
    assert.throws(() => tenantDataPath(bad), /Empresa no válida/);
  }
});
