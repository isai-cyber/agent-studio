// Roles por empresa. Los del sistema (Propietario, Admin, Operador, Solo lectura)
// son plantillas de solo lectura y sus permisos se calculan en código; cada
// empresa puede crear roles propios o clonar los del sistema.
//
// Regla anti escalada: nadie puede crear, editar ni asignar un rol con permisos
// que él mismo no tenga.
import { tenantDb } from '../db/tenant-db.ts';
import { allPermissions, isKnownPermission, systemRolePermissions, type SystemRoleKey } from '../authz/permissions.ts';
import { invalidatePermissions } from '../authz/cache.ts';

export interface Role { id: number; tenantId: number | null; name: string; description: string | null; isSystem: boolean; systemKey: SystemRoleKey | null; permissions: string[] }

const fail = (status: number, message: string, extra: object = {}) => Object.assign(new Error(message), { status, ...extra });

async function customPermissions(tenantId: number, roleId: number): Promise<string[]> {
  const rows = await tenantDb(tenantId).query('SELECT permission FROM role_permissions WHERE tenant_id = :tenant AND role_id = ?', [roleId]);
  const known = new Set(allPermissions());
  return rows.map((r: { permission: string }) => r.permission).filter((p: string) => known.has(p));
}

async function toRole(tenantId: number, r: any): Promise<Role> {
  const isSystem = Boolean(r.is_system);
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, description: r.description ?? null, isSystem, systemKey: r.system_key ?? null,
    permissions: isSystem ? systemRolePermissions(r.system_key) : await customPermissions(tenantId, r.id),
  };
}

export async function listRoles(tenantId: number): Promise<Role[]> {
  const rows = await tenantDb(tenantId).query('SELECT * FROM roles WHERE tenant_id = :tenant OR (tenant_id IS NULL AND is_system = 1) ORDER BY is_system DESC, id');
  return Promise.all(rows.map((r: any) => toRole(tenantId, r)));
}

// Un rol del sistema o uno propio de esta empresa (nunca el de otra)
export async function getRole(tenantId: number, roleId: number): Promise<Role> {
  const rows = await tenantDb(tenantId).query('SELECT * FROM roles WHERE id = ? AND (tenant_id = :tenant OR (tenant_id IS NULL AND is_system = 1))', [Number(roleId)]);
  if (!rows[0]) throw fail(404, 'Rol no encontrado');
  return toRole(tenantId, rows[0]);
}

export function assertSubset(perms: string[], actorPerms: Set<string>): void {
  const extra = perms.filter((p) => !actorPerms.has(p));
  if (extra.length) throw fail(403, `No puedes dar permisos que no tienes: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? '…' : ''}`);
}

function cleanPermissions(perms: unknown): string[] {
  if (!Array.isArray(perms)) throw fail(400, 'Los permisos deben ser una lista');
  const list = [...new Set(perms.map(String))];
  const unknown = list.filter((p) => !isKnownPermission(p));
  if (unknown.length) throw fail(400, `Permisos desconocidos: ${unknown.join(', ')}`);
  return list;
}

function cleanName(name: unknown): string {
  const n = String(name ?? '').trim();
  if (!n || n.length > 80) throw fail(400, 'Escribe un nombre para el rol (máximo 80 caracteres).');
  return n;
}

export async function createRole(tenantId: number, input: { name?: string; description?: string; permissions?: string[]; cloneFrom?: number }, actorPerms: Set<string>): Promise<Role> {
  const name = cleanName(input.name);
  const permissions = input.cloneFrom ? (await getRole(tenantId, input.cloneFrom)).permissions : cleanPermissions(input.permissions ?? []);
  assertSubset(permissions, actorPerms);
  const t = tenantDb(tenantId);
  const dup = await t.query('SELECT id FROM roles WHERE tenant_id = :tenant AND name = ?', [name]);
  if (dup.length) throw fail(409, 'Ya existe un rol con ese nombre');
  const r = await t.query('INSERT INTO roles (tenant_id, name, description, is_system) VALUES (:tenant, ?, ?, 0)', [name, String(input.description ?? '').slice(0, 255) || null]);
  for (const p of permissions) await t.query('INSERT INTO role_permissions (role_id, tenant_id, permission) VALUES (?, :tenant, ?)', [r.insertId, p]);
  return getRole(tenantId, r.insertId);
}

export async function updateRole(tenantId: number, roleId: number, input: { name?: string; description?: string; permissions?: string[] }, actorPerms: Set<string>): Promise<{ before: Role; after: Role }> {
  const before = await getRole(tenantId, roleId);
  if (before.isSystem) throw fail(400, 'Los roles del sistema no se pueden editar: clónalo para crear uno propio.');
  // Tampoco se puede tocar un rol que ya tiene más permisos que tú
  assertSubset(before.permissions, actorPerms);
  const t = tenantDb(tenantId);
  if (input.name !== undefined || input.description !== undefined) {
    await t.query('UPDATE roles SET name = ?, description = ? WHERE tenant_id = :tenant AND id = ?', [input.name !== undefined ? cleanName(input.name) : before.name, input.description !== undefined ? String(input.description).slice(0, 255) : before.description, roleId]);
  }
  if (input.permissions !== undefined) {
    const permissions = cleanPermissions(input.permissions);
    assertSubset(permissions, actorPerms);
    await t.query('DELETE FROM role_permissions WHERE tenant_id = :tenant AND role_id = ?', [roleId]);
    for (const p of permissions) await t.query('INSERT INTO role_permissions (role_id, tenant_id, permission) VALUES (?, :tenant, ?)', [roleId, p]);
  }
  invalidatePermissions(tenantId);
  return { before, after: await getRole(tenantId, roleId) };
}

export async function deleteRole(tenantId: number, roleId: number, actorPerms: Set<string>): Promise<Role> {
  const role = await getRole(tenantId, roleId);
  if (role.isSystem) throw fail(400, 'Los roles del sistema no se pueden eliminar.');
  assertSubset(role.permissions, actorPerms);
  const t = tenantDb(tenantId);
  const [{ n }] = await t.query('SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = :tenant AND role_id = ?', [roleId]);
  const [{ i }] = await t.query('SELECT COUNT(*) AS i FROM invitations WHERE tenant_id = :tenant AND role_id = ? AND accepted_at IS NULL AND expires_at > NOW()', [roleId]);
  if (n + i > 0) throw fail(409, `El rol está asignado a ${n} usuario(s) o invitación(es) pendientes: cámbiales el rol antes de eliminarlo.`);
  await t.query('DELETE FROM role_permissions WHERE tenant_id = :tenant AND role_id = ?', [roleId]);
  await t.query('DELETE FROM roles WHERE tenant_id = :tenant AND id = ?', [roleId]);
  invalidatePermissions(tenantId);
  return role;
}
