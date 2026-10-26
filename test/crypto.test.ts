import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './_helpers.ts';

await setupEnv('crypto');
const { encrypt, decrypt, isEncrypted } = await import('../src/tenancy/crypto.ts');

test('cifra y descifra con la clave de la empresa', () => {
  const c = encrypt(1, 'connection:slack', '{"token":"xoxb-secreto"}');
  assert.ok(isEncrypted(c));
  assert.ok(!c.includes('xoxb'));
  assert.equal(decrypt(1, 'connection:slack', c), '{"token":"xoxb-secreto"}');
});

test('otra empresa u otra app no pueden descifrarlo', () => {
  const c = encrypt(1, 'connection:slack', 'secreto');
  assert.throws(() => decrypt(2, 'connection:slack', c));
  assert.throws(() => decrypt(1, 'connection:github', c));
});

test('cada cifrado usa un IV distinto', () => {
  assert.notEqual(encrypt(1, 'x', 'igual'), encrypt(1, 'x', 'igual'));
});
