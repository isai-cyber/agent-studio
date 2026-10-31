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

// Auditoría de acciones de plataforma (sin empresa)
export async function insertPlatformAudit(row: unknown[]): Promise<void> {
  await db().query('INSERT INTO audit_log (tenant_id, actor_user_id, actor_type, action, target, `before`, `after`, ip) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)', row);
}

// Una clave de API llega sin empresa: se busca por su hash y de ahí sale la empresa
export async function findApiKeyByHash(hash: string): Promise<{ id: number; tenant_id: number; scopes: unknown; revoked_at: Date | null; name: string } | null> {
  const rows = await db().query('SELECT id, tenant_id, name, scopes, revoked_at FROM api_keys WHERE key_hash = ?', [hash]);
  return rows[0] ?? null;
}

export interface UserMembership { tenantId: number; slug: string; name: string; tenantStatus: string; roleId: number; roleName: string; systemKey: string | null; status: 'active' | 'disabled' }

// Empresas a las que pertenece un usuario (para el selector de empresa)
export async function membershipsOfUser(userId: number): Promise<UserMembership[]> {
  const rows = await db().query(
    `SELECT m.tenant_id, t.slug, t.name, t.status AS tenant_status, m.role_id, r.name AS role_name, r.system_key, m.status
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = ? AND t.status <> 'deleted' ORDER BY t.name`,
    [userId],
  );
  return rows.map((r: any) => ({ tenantId: r.tenant_id, slug: r.slug, name: r.name, tenantStatus: r.tenant_status, roleId: r.role_id, roleName: r.role_name, systemKey: r.system_key, status: r.status }));
}

// Número de miembros por empresa (panel del superadmin)
export async function memberCounts(): Promise<Map<number, number>> {
  const rows = await db().query("SELECT tenant_id, COUNT(*) AS n FROM memberships WHERE status = 'active' GROUP BY tenant_id");
  return new Map(rows.map((r: any) => [r.tenant_id, r.n]));
}

// Una invitación llega por enlace, sin empresa: se busca por el hash del token
export async function findInvitationByHash(hash: string): Promise<{ id: number; tenant_id: number; email: string; role_id: number; expires_at: Date; accepted_at: Date | null } | null> {
  const rows = await db().query('SELECT id, tenant_id, email, role_id, expires_at, accepted_at FROM invitations WHERE token_hash = ?', [hash]);
  return rows[0] ?? null;
}

// Web publicada por dominio propio (llega una petición con Host: www.cliente.com)
export async function siteTenantByDomain(domain: string): Promise<number | null> {
  const rows = await db().query('SELECT tenant_id FROM sites WHERE custom_domain = ? AND published = 1', [domain.toLowerCase()]);
  return rows[0]?.tenant_id ?? null;
}
