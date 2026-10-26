// Consultas de plataforma (las que cruzan empresas o leen datos globales, como
// los roles del sistema). Es el único archivo, junto a las migraciones, que puede
// consultar tablas de empresa sin el helper tenantDb(): lo vigila
// test/tenant-db.test.ts. Úsalo solo para operaciones de superadmin.
import { db } from '../db/pool.ts';
import type { SystemRoleKey } from '../authz/permissions.ts';

export async function systemRoleId(key: SystemRoleKey): Promise<number> {
  const rows = await db().query('SELECT id FROM roles WHERE tenant_id IS NULL AND is_system = 1 AND system_key = ?', [key]);
  if (!rows[0]) throw new Error(`Falta el rol del sistema "${key}": ejecuta npm run migrate:tenancy`);
  return rows[0].id;
}
