// Contexto de autorización de cada petición: quién actúa (usuario, clave de API,
// superadmin en modo soporte o el sistema), en qué empresa y con qué permisos.
// Lo construyen el middleware de /api (sesión), /v1 y /mcp (clave de API), los
// webhooks y el programador de flujos.
import { dbEnabled } from '../db/pool.ts';
import { tenantDb } from '../db/tenant-db.ts';
import { allPermissions, systemRolePermissions, type SystemRoleKey } from './permissions.ts';
import { cachedFor } from './cache.ts';
import { getRole } from '../tenancy/roles.ts';
import { getTenant, planOfTenant, LOCAL_TENANT, LOCAL_PLAN, type Plan, type Tenant } from '../tenancy/tenants.ts';
import { membershipsOfUser, type UserMembership } from '../tenancy/platform.ts';
import type { AuditActor } from '../tenancy/audit.ts';
import type { ApiKeyAuth } from '../tenancy/apikeys.ts';
import { DEFAULT_TENANT_ID } from '../tenancy/paths.ts';

export interface SessionUser { id: number; email: string; name: string; isPlatformAdmin: boolean }

export interface Ctx {
  tenantId: number;
  tenant: Tenant;
  plan: Plan;
  actor: AuditActor;
  user: SessionUser | null;
  role: { id: number; name: string; systemKey: SystemRoleKey | null } | null;
  permissions: Set<string>;
  support: boolean; // superadmin dentro de una empresa de la que no es miembro
  apiKey: { id: number | null; name: string } | null;
  ip: string | null;
  local: boolean; // instalación sin MariaDB (sin login): todos los permisos
}

// Usuario con sesión pero sin empresa (sin invitaciones aceptadas)
export interface NoTenant { tenantId: null; user: SessionUser; memberships: UserMembership[] }

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export function localContext(ip: string | null = null): Ctx {
  return { tenantId: DEFAULT_TENANT_ID, tenant: LOCAL_TENANT, plan: LOCAL_PLAN, actor: { type: 'user' }, user: null, role: null, permissions: new Set(allPermissions()), support: false, apiKey: null, ip, local: true };
}

// Permisos del rol de un miembro (con caché corta)
async function memberRole(tenantId: number, userId: number): Promise<{ roleId: number; status: string } | null> {
  const rows = await tenantDb(tenantId).query('SELECT role_id, status FROM memberships WHERE tenant_id = :tenant AND user_id = ?', [userId]);
  return rows[0] ? { roleId: rows[0].role_id, status: rows[0].status } : null;
}

async function rolePermissionsCached(tenantId: number, roleId: number) {
  return cachedFor(tenantId, `role:${roleId}`, async () => {
    const r = await getRole(tenantId, roleId);
    return { id: r.id, name: r.name, systemKey: r.systemKey, permissions: r.permissions };
  });
}

// Empresa activa de la sesión: la guardada si sigue siendo válida; si no, la primera
// de la que es miembro activo. El superadmin puede estar en cualquiera (modo soporte).
export async function contextForUser(user: SessionUser, activeTenantId: number | null, ip: string | null): Promise<Ctx | NoTenant> {
  if (!dbEnabled) return { ...localContext(ip), user };
  const memberships = await membershipsOfUser(user.id);
  const usable = memberships.filter((m) => m.status === 'active' && m.tenantStatus === 'active');
  let tenantId = activeTenantId && usable.some((m) => m.tenantId === activeTenantId) ? activeTenantId : null;
  let support = false;
  if (!tenantId && activeTenantId && user.isPlatformAdmin) {
    const t = await getTenant(activeTenantId);
    if (t && t.status !== 'deleted') { tenantId = activeTenantId; support = !memberships.some((m) => m.tenantId === activeTenantId && m.status === 'active'); }
  }
  tenantId ??= usable[0]?.tenantId ?? null;
  if (!tenantId) return { tenantId: null, user, memberships };
  const tenant = (await getTenant(tenantId))!;
  const plan = await planOfTenant(tenantId);
  if (support) {
    // Soporte: lo que puede un Admin (nunca facturación ni eliminar la empresa)
    return { tenantId, tenant, plan, actor: { type: 'superadmin', userId: user.id }, user, role: { id: 0, name: 'Soporte (superadmin)', systemKey: 'admin' }, permissions: new Set(systemRolePermissions('admin')), support: true, apiKey: null, ip, local: false };
  }
  const m = await cachedFor(tenantId, `member:${user.id}`, () => memberRole(tenantId!, user.id));
  if (!m || m.status !== 'active') throw fail(403, 'Tu acceso a esta empresa está desactivado.');
  const role = await rolePermissionsCached(tenantId, m.roleId);
  return { tenantId, tenant, plan, actor: { type: 'user', userId: user.id }, user, role: { id: role.id, name: role.name, systemKey: role.systemKey }, permissions: new Set(role.permissions), support: false, apiKey: null, ip, local: false };
}

export async function contextForApiKey(key: ApiKeyAuth, ip: string | null): Promise<Ctx> {
  if (!dbEnabled) return { ...localContext(ip), actor: { type: 'api_key' }, apiKey: { id: key.keyId, name: key.name } };
  const tenant = await getTenant(key.tenantId);
  if (!tenant || tenant.status === 'deleted') throw fail(401, 'La clave de API no es válida.');
  return { tenantId: tenant.id, tenant, plan: await planOfTenant(tenant.id), actor: { type: 'api_key', apiKeyId: key.keyId }, user: null, role: null, permissions: key.permissions, support: false, apiKey: { id: key.keyId, name: key.name }, ip, local: false };
}

// Para procesos internos (webhooks, programador): sin permisos de usuario, solo módulos
export async function systemContext(tenantId: number, ip: string | null = null): Promise<Ctx> {
  if (!dbEnabled) return { ...localContext(ip), actor: { type: 'system' } };
  const tenant = await getTenant(tenantId);
  if (!tenant) throw fail(404, 'Empresa no encontrada');
  return { tenantId, tenant, plan: await planOfTenant(tenantId), actor: { type: 'system' }, user: null, role: null, permissions: new Set(allPermissions()), support: false, apiKey: null, ip, local: false };
}
