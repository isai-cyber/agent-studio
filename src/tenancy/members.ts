// Usuarios de una empresa: miembros, invitaciones, cambio de rol, desactivar y quitar.
//
// Reglas:
// - Solo se asigna un rol cuyos permisos tenga quien lo asigna (anti escalada);
//   por eso solo un Propietario puede nombrar a otro Propietario.
// - Tampoco se puede tocar a alguien con más permisos que uno mismo.
// - Siempre queda al menos un Propietario activo.
import { createHash, randomBytes } from 'node:crypto';
import { tenantDb } from '../db/tenant-db.ts';
import { db } from '../db/pool.ts';
import { getRole, assertSubset } from './roles.ts';
import { findInvitationByHash } from './platform.ts';
import { planOfTenant, getTenant } from './tenants.ts';
import { invalidatePermissions } from '../authz/cache.ts';
import { sendMail, mailConfigured } from './mail.ts';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,180}\.[^\s@]{2,}$/;
const INVITE_DAYS = 7;

export interface Member { userId: number; email: string; name: string; roleId: number; roleName: string; systemKey: string | null; status: 'active' | 'disabled'; lastLoginAt: string | null }
export interface Invitation { id: number; email: string; roleId: number; roleName: string; expiresAt: string; createdAt: string }

export async function listMembers(tenantId: number): Promise<Member[]> {
  const rows = await tenantDb(tenantId).query(
    `SELECT m.user_id, u.email, u.name, m.role_id, r.name AS role_name, r.system_key, m.status, u.last_login_at
       FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
      WHERE m.tenant_id = :tenant ORDER BY u.name`,
  );
  return rows.map((r: any) => ({ userId: r.user_id, email: r.email, name: r.name, roleId: r.role_id, roleName: r.role_name, systemKey: r.system_key, status: r.status, lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null }));
}

export async function listInvitations(tenantId: number): Promise<Invitation[]> {
  const rows = await tenantDb(tenantId).query(
    `SELECT i.id, i.email, i.role_id, r.name AS role_name, i.expires_at, i.created_at FROM invitations i JOIN roles r ON r.id = i.role_id
      WHERE i.tenant_id = :tenant AND i.accepted_at IS NULL AND i.expires_at > NOW() ORDER BY i.id DESC`,
  );
  return rows.map((r: any) => ({ id: r.id, email: r.email, roleId: r.role_id, roleName: r.role_name, expiresAt: new Date(r.expires_at).toISOString(), createdAt: new Date(r.created_at).toISOString() }));
}

async function getMember(tenantId: number, userId: number): Promise<Member> {
  const m = (await listMembers(tenantId)).find((x) => x.userId === Number(userId));
  if (!m) throw fail(404, 'Ese usuario no pertenece a la empresa');
  return m;
}

async function activeOwners(tenantId: number): Promise<number> {
  const [{ n }] = await tenantDb(tenantId).query("SELECT COUNT(*) AS n FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.tenant_id = :tenant AND m.status = 'active' AND r.system_key = 'owner'");
  return n;
}

async function assertSeat(tenantId: number): Promise<void> {
  const plan = await planOfTenant(tenantId);
  if (plan.maxUsers === null) return;
  const t = tenantDb(tenantId);
  const [{ n }] = await t.query("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = :tenant AND status = 'active'");
  const [{ i }] = await t.query('SELECT COUNT(*) AS i FROM invitations WHERE tenant_id = :tenant AND accepted_at IS NULL AND expires_at > NOW()');
  if (n + i >= plan.maxUsers) throw fail(403, `Tu plan (${plan.name}) permite ${plan.maxUsers} usuarios. Mejora el plan para invitar a más.`);
}

// Quien actúa debe tener todos los permisos del rol del usuario al que toca
async function assertCanManage(tenantId: number, target: Member, actorPerms: Set<string>): Promise<void> {
  assertSubset((await getRole(tenantId, target.roleId)).permissions, actorPerms);
}

export async function invite(tenantId: number, input: { email?: string; roleId?: number }, actor: { userId: number | null; permissions: Set<string> }, baseUrl: string): Promise<{ invitation: Invitation; link: string; emailed: boolean }> {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw fail(400, 'El email no es válido.');
  const role = await getRole(tenantId, Number(input.roleId));
  assertSubset(role.permissions, actor.permissions);
  const t = tenantDb(tenantId);
  const existing = await t.query('SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = :tenant AND u.email = ?', [email]);
  if (existing.length) throw fail(409, 'Ese usuario ya pertenece a la empresa.');
  await assertSeat(tenantId);
  // Una invitación nueva al mismo email sustituye a la anterior
  await t.query('UPDATE invitations SET expires_at = NOW() WHERE tenant_id = :tenant AND email = ? AND accepted_at IS NULL', [email]);
  const token = randomBytes(32).toString('base64url');
  const r = await t.query('INSERT INTO invitations (tenant_id, email, role_id, token_hash, invited_by, expires_at) VALUES (:tenant, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))', [email, role.id, sha(token), actor.userId, INVITE_DAYS]);
  const link = `${baseUrl}/?invite=${token}`;
  const tenant = await getTenant(tenantId);
  const en = tenant?.language === 'en';
  const emailed = mailConfigured()
    ? await sendMail(email,
      en ? `Invitation to ${tenant?.name ?? 'CrawStudio A.I'}` : `Invitación a ${tenant?.name ?? 'CrawStudio A.I'}`,
      en ? `You were invited to join ${tenant?.name} on CrawStudio A.I.\n\nAccept the invitation here (expires in ${INVITE_DAYS} days):\n${link}\n`
        : `Te invitaron a unirte a ${tenant?.name} en CrawStudio A.I con el rol ${role.name}.\n\nAcepta la invitación aquí (caduca en ${INVITE_DAYS} días):\n${link}\n`)
    : false;
  const invitation = (await listInvitations(tenantId)).find((i) => i.id === r.insertId)!;
  return { invitation, link, emailed };
}

export async function revokeInvitation(tenantId: number, id: number): Promise<void> {
  const r = await tenantDb(tenantId).query('UPDATE invitations SET expires_at = NOW() WHERE tenant_id = :tenant AND id = ? AND accepted_at IS NULL', [Number(id)]);
  if (!r.affectedRows) throw fail(404, 'Invitación no encontrada');
}

// Datos públicos de una invitación (para la pantalla de registro)
export async function invitationInfo(token: string): Promise<{ email: string; tenantName: string; roleName: string; language: string } | null> {
  const inv = await findInvitationByHash(sha(String(token)));
  if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) return null;
  const tenant = await getTenant(inv.tenant_id);
  if (!tenant || tenant.status !== 'active') return null;
  return { email: inv.email, tenantName: tenant.name, roleName: (await getRole(inv.tenant_id, inv.role_id)).name, language: tenant.language };
}

export async function acceptInvitation(token: string, user: { id: number; email: string }): Promise<{ tenantId: number; roleId: number }> {
  const inv = await findInvitationByHash(sha(String(token)));
  if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) throw fail(410, 'La invitación no existe o caducó. Pide una nueva.');
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw fail(403, `Esta invitación es para ${inv.email}. Entra con esa cuenta.`);
  const t = tenantDb(inv.tenant_id);
  await t.query('INSERT INTO memberships (user_id, tenant_id, role_id) VALUES (?, :tenant, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), status = \'active\'', [user.id, inv.role_id]);
  await t.query('UPDATE invitations SET accepted_at = NOW() WHERE tenant_id = :tenant AND id = ?', [inv.id]);
  invalidatePermissions(inv.tenant_id);
  return { tenantId: inv.tenant_id, roleId: inv.role_id };
}

export async function changeRole(tenantId: number, userId: number, roleId: number, actorPerms: Set<string>): Promise<{ before: Member; after: Member }> {
  const before = await getMember(tenantId, userId);
  await assertCanManage(tenantId, before, actorPerms);
  const role = await getRole(tenantId, roleId);
  assertSubset(role.permissions, actorPerms);
  if (before.systemKey === 'owner' && role.systemKey !== 'owner' && before.status === 'active' && (await activeOwners(tenantId)) <= 1) {
    throw fail(409, 'No puedes quitarle el rol al último Propietario. Nombra antes a otro Propietario.');
  }
  await tenantDb(tenantId).query('UPDATE memberships SET role_id = ? WHERE tenant_id = :tenant AND user_id = ?', [role.id, userId]);
  invalidatePermissions(tenantId);
  return { before, after: await getMember(tenantId, userId) };
}

export async function setMemberStatus(tenantId: number, userId: number, status: 'active' | 'disabled', actorPerms: Set<string>): Promise<{ before: Member; after: Member }> {
  if (status !== 'active' && status !== 'disabled') throw fail(400, 'Estado no válido');
  const before = await getMember(tenantId, userId);
  await assertCanManage(tenantId, before, actorPerms);
  if (status === 'disabled' && before.systemKey === 'owner' && before.status === 'active' && (await activeOwners(tenantId)) <= 1) {
    throw fail(409, 'No puedes desactivar al último Propietario.');
  }
  if (status === 'active' && before.status === 'disabled') await assertSeat(tenantId);
  await tenantDb(tenantId).query('UPDATE memberships SET status = ? WHERE tenant_id = :tenant AND user_id = ?', [status, userId]);
  invalidatePermissions(tenantId);
  return { before, after: await getMember(tenantId, userId) };
}

export async function removeMember(tenantId: number, userId: number, actorPerms: Set<string>): Promise<Member> {
  const before = await getMember(tenantId, userId);
  await assertCanManage(tenantId, before, actorPerms);
  if (before.systemKey === 'owner' && before.status === 'active' && (await activeOwners(tenantId)) <= 1) throw fail(409, 'No puedes quitar al último Propietario.');
  await tenantDb(tenantId).query('DELETE FROM memberships WHERE tenant_id = :tenant AND user_id = ?', [userId]);
  // Su sesión deja de apuntar a esta empresa
  await db().query('UPDATE sessions SET active_tenant_id = NULL WHERE user_id = ? AND active_tenant_id = ?', [userId, tenantId]);
  invalidatePermissions(tenantId);
  return before;
}
