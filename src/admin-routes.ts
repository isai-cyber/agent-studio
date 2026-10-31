// Rutas de administración: contexto del usuario, selector de empresa, usuarios,
// roles, claves de API, auditoría, módulos y, para el superadmin, empresas y planes.
// Todo cambio queda en la auditoría.
import type { IncomingMessage } from 'node:http';
import { route, send, json, query } from './http.ts';
import type { Ctx } from './authz/context.ts';
import { dbEnabled } from './db/pool.ts';
import { setActiveTenant } from './auth.ts';
import { audit, listAudit, auditCsv } from './tenancy/audit.ts';
import { listRoles, createRole, updateRole, deleteRole } from './tenancy/roles.ts';
import { listMembers, listInvitations, invite, revokeInvitation, acceptInvitation, changeRole, setMemberStatus, removeMember } from './tenancy/members.ts';
import { listApiKeys, createApiKey, revokeApiKey } from './tenancy/apikeys.ts';
import { listTenants, createTenant, updateTenant, getTenant, listPlans, savePlan, planOfTenant } from './tenancy/tenants.ts';
import { membershipsOfUser, memberCounts, systemRoleId } from './tenancy/platform.ts';
import { mailConfigured } from './tenancy/mail.ts';
import { PLATFORM_PERMISSIONS, featurePermissions } from './authz/permissions.ts';
import { invalidatePermissions } from './authz/cache.ts';
import { FEATURES, GROUPS, getFeature } from './features/registry.ts';
import { tenantFeatures, setFeatureEnabled, setFeatureConfig } from './features/state.ts';
import { usageSince } from './metrics.ts';
import { countAgents } from './store.ts';
import { DEFAULT_TENANT_ID } from './tenancy/paths.ts';
import { maskedSettings, updatePlatformSettings } from './platform-settings.ts';
import { llmStatus, testProvider } from './llm.ts';
import { testJev, jevConfigured, JEV_MODEL } from './jev.ts';
import { agentBackend, status as claudeCodeStatus } from './claude-code.ts';
import { billingStatus, listCharges, createCharge, refreshCharge, setChargeStatus } from './platform-billing.ts';
import { LANGUAGES } from './tenancy/tenants.ts';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const actorOf = (ctx: Ctx) => ({ actor: ctx.actor, ip: ctx.ip });
const baseUrl = (req: IncomingMessage) => `${req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === 'true' ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
const sessionOf = (req: IncomingMessage) => (req as IncomingMessage & { session?: { tokenHash: string | null; noTenant: { user: Ctx['user']; memberships: unknown[] } | null } }).session!;
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

// Definición + estado de cada módulo, para la interfaz
async function featuresView(tenantId: number) {
  const states = await tenantFeatures(tenantId);
  return FEATURES.map((f) => {
    const st = states.get(f.key)!;
    const dependents = FEATURES.filter((d) => d.dependsOn.includes(f.key) && states.get(d.key)!.enabled).map((d) => d.key);
    return { ...f, ...st, dependents };
  });
}

const visibleNav = (features: { navItems: string[]; usable: boolean }[]) => features.filter((f) => f.usable).flatMap((f) => f.navItems);

export function registerAdminRoutes(): void {
  // ---------- contexto y selector de empresa ----------
  route('GET', '/api/me/context', { noTenant: true }, async (req, res, _p, ctx) => {
    const s = sessionOf(req);
    if (!ctx) {
      return send(res, 200, { authEnabled: dbEnabled, user: s.noTenant?.user ?? null, tenant: null, tenants: [], permissions: [], features: [], nav: [], support: false, local: false });
    }
    const features = await featuresView(ctx.tenantId);
    const tenants = ctx.local ? [{ tenantId: ctx.tenantId, slug: ctx.tenant.slug, name: ctx.tenant.name, roleName: 'Propietario', status: 'active' }]
      : (await membershipsOfUser(ctx.user!.id)).filter((m) => m.status === 'active' && m.tenantStatus === 'active');
    send(res, 200, {
      authEnabled: dbEnabled,
      user: ctx.user,
      tenant: { ...ctx.tenant, plan: { id: ctx.plan.id, name: ctx.plan.name, key: ctx.plan.key } },
      tenants,
      role: ctx.role,
      permissions: [...ctx.permissions],
      features,
      groups: GROUPS,
      nav: visibleNav(features),
      support: ctx.support,
      local: ctx.local,
    });
  });

  route('POST', '/api/me/tenant', { noTenant: true }, async (req, res, _p, ctx) => {
    const s = sessionOf(req);
    if (!dbEnabled || !s.tokenHash) return send(res, 400, { error: 'Sin MariaDB solo hay una empresa.' });
    const { tenantId } = await json<{ tenantId?: number }>(req);
    const user = ctx?.user ?? s.noTenant?.user;
    const m = (await membershipsOfUser(user!.id)).find((x) => x.tenantId === Number(tenantId) && x.status === 'active' && x.tenantStatus === 'active');
    if (!m) throw fail(403, 'No perteneces a esa empresa.');
    await setActiveTenant(s.tokenHash, m.tenantId);
    send(res, 200, { tenantId: m.tenantId });
  });

  route('POST', '/api/me/invitations/accept', { noTenant: true }, async (req, res, _p, ctx) => {
    const s = sessionOf(req);
    const user = ctx?.user ?? s.noTenant?.user;
    if (!user || !s.tokenHash) throw fail(400, 'Inicia sesión para aceptar la invitación.');
    const { token } = await json<{ token?: string }>(req);
    const r = await acceptInvitation(String(token ?? ''), user);
    await setActiveTenant(s.tokenHash, r.tenantId);
    await audit({ tenantId: r.tenantId, actor: { type: 'user', userId: user.id }, ip: ctx?.ip ?? null, action: 'member.joined', target: `user:${user.id}`, after: { roleId: r.roleId } });
    send(res, 200, r);
  });

  // ---------- usuarios ----------
  route('GET', '/api/tenant/users', { perm: 'tenant.users.manage' }, async (_req, res, _p, ctx) => {
    send(res, 200, { members: await listMembers(ctx.tenantId), invitations: await listInvitations(ctx.tenantId), roles: await listRoles(ctx.tenantId), mail: mailConfigured(), maxUsers: ctx.plan.maxUsers });
  });
  route('POST', '/api/tenant/invitations', { perm: 'tenant.users.manage' }, async (req, res, _p, ctx) => {
    const body = await json<{ email?: string; roleId?: number }>(req);
    const r = await invite(ctx.tenantId, body, { userId: ctx.user?.id ?? null, permissions: ctx.permissions }, baseUrl(req));
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'member.invited', target: `email:${r.invitation.email}`, after: { role: r.invitation.roleName, emailed: r.emailed } });
    // El enlace solo se devuelve si no se pudo mandar por correo
    send(res, 201, { invitation: r.invitation, emailed: r.emailed, link: r.emailed ? null : r.link });
  });
  route('DELETE', '/api/tenant/invitations/:id', { perm: 'tenant.users.manage' }, async (_req, res, [id], ctx) => {
    await revokeInvitation(ctx.tenantId, Number(id));
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'member.invitation_revoked', target: `invitation:${id}` });
    send(res, 204, '');
  });
  route('PUT', '/api/tenant/users/:id/role', { perm: 'tenant.users.manage' }, async (req, res, [id], ctx) => {
    const { roleId } = await json<{ roleId?: number }>(req);
    const r = await changeRole(ctx.tenantId, Number(id), Number(roleId), ctx.permissions);
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'member.role_changed', target: `user:${id}`, before: { role: r.before.roleName }, after: { role: r.after.roleName } });
    send(res, 200, r.after);
  });
  route('PUT', '/api/tenant/users/:id/status', { perm: 'tenant.users.manage' }, async (req, res, [id], ctx) => {
    const { status } = await json<{ status?: 'active' | 'disabled' }>(req);
    if (ctx.user?.id === Number(id) && status === 'disabled') throw fail(400, 'No puedes desactivarte a ti mismo.');
    const r = await setMemberStatus(ctx.tenantId, Number(id), status!, ctx.permissions);
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: status === 'disabled' ? 'member.disabled' : 'member.enabled', target: `user:${id}`, before: { status: r.before.status }, after: { status: r.after.status } });
    send(res, 200, r.after);
  });
  route('DELETE', '/api/tenant/users/:id', { perm: 'tenant.users.manage' }, async (_req, res, [id], ctx) => {
    const m = await removeMember(ctx.tenantId, Number(id), ctx.permissions);
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'member.removed', target: `user:${id}`, before: { email: m.email, role: m.roleName } });
    send(res, 204, '');
  });

  // ---------- roles ----------
  const ROLE_READERS = ['tenant.roles.manage', 'tenant.users.manage', 'tenant.apikeys.manage'];
  route('GET', '/api/tenant/permissions', { anyPerm: ROLE_READERS }, async (_req, res) => {
    const groups = new Map<string, { key: string; label: string }[]>();
    for (const p of [...PLATFORM_PERMISSIONS, ...featurePermissions()]) (groups.get(p.group) ?? groups.set(p.group, []).get(p.group)!).push({ key: p.key, label: p.label });
    send(res, 200, [...groups].map(([group, permissions]) => ({ group, permissions })));
  });
  route('GET', '/api/tenant/roles', { anyPerm: ROLE_READERS }, async (_req, res, _p, ctx) => send(res, 200, await listRoles(ctx.tenantId)));
  route('POST', '/api/tenant/roles', { perm: 'tenant.roles.manage' }, async (req, res, _p, ctx) => {
    const role = await createRole(ctx.tenantId, await json(req), ctx.permissions);
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'role.created', target: `role:${role.id}`, after: { name: role.name, permissions: role.permissions } });
    send(res, 201, role);
  });
  route('PUT', '/api/tenant/roles/:id', { perm: 'tenant.roles.manage' }, async (req, res, [id], ctx) => {
    const r = await updateRole(ctx.tenantId, Number(id), await json(req), ctx.permissions);
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'role.updated', target: `role:${id}`, before: { name: r.before.name, permissions: r.before.permissions }, after: { name: r.after.name, permissions: r.after.permissions } });
    send(res, 200, r.after);
  });
  route('DELETE', '/api/tenant/roles/:id', { perm: 'tenant.roles.manage' }, async (_req, res, [id], ctx) => {
    const r = await deleteRole(ctx.tenantId, Number(id), ctx.permissions);
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'role.deleted', target: `role:${id}`, before: { name: r.name, permissions: r.permissions } });
    send(res, 204, '');
  });

  // ---------- claves de API ----------
  route('GET', '/api/tenant/apikeys', { perm: 'tenant.apikeys.manage' }, async (_req, res, _p, ctx) => send(res, 200, await listApiKeys(ctx.tenantId)));
  route('POST', '/api/tenant/apikeys', { perm: 'tenant.apikeys.manage' }, async (req, res, _p, ctx) => {
    const r = await createApiKey(ctx.tenantId, await json(req), { userId: ctx.user?.id ?? null, permissions: ctx.permissions });
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'apikey.created', target: `api_key:${r.info.id}`, after: { name: r.info.name, prefix: r.info.prefix, scopes: r.info.scopes } });
    send(res, 201, { key: r.key, info: r.info }); // la clave completa solo se ve esta vez
  });
  route('DELETE', '/api/tenant/apikeys/:id', { perm: 'tenant.apikeys.manage' }, async (_req, res, [id], ctx) => {
    const k = await revokeApiKey(ctx.tenantId, Number(id));
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'apikey.revoked', target: `api_key:${id}`, before: { name: k.name, prefix: k.prefix } });
    send(res, 204, '');
  });

  // ---------- auditoría (solo lectura) ----------
  const filters = (req: IncomingMessage) => { const q = query(req); return { actor: q.get('actor') ?? undefined, action: q.get('action') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, limit: Number(q.get('limit') ?? 100), offset: Number(q.get('offset') ?? 0) }; };
  route('GET', '/api/tenant/audit', { perm: 'audit.read', feature: 'audit_log' }, async (req, res, _p, ctx) => send(res, 200, await listAudit(ctx.tenantId, filters(req))));
  route('GET', '/api/tenant/audit.csv', { perm: 'audit.read', feature: 'audit_log' }, async (req, res, _p, ctx) => {
    const { rows } = await listAudit(ctx.tenantId, { ...filters(req), limit: 5000, offset: 0 });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="auditoria-${ctx.tenant.slug}.csv"` });
    res.end(auditCsv(rows));
  });

  // ---------- módulos de negocio ----------
  route('GET', '/api/tenant/features', {}, async (_req, res, _p, ctx) => send(res, 200, { features: await featuresView(ctx.tenantId), groups: GROUPS }));
  route('PUT', '/api/tenant/features/:key', { perm: 'tenant.features.manage' }, async (req, res, [key], ctx) => {
    const { enabled, cascade } = await json<{ enabled?: boolean; cascade?: boolean }>(req);
    const r = await setFeatureEnabled(ctx.tenantId, key, Boolean(enabled), { cascade: Boolean(cascade), ...actorOf(ctx), isPlatformAdmin: Boolean(ctx.user?.isPlatformAdmin) });
    send(res, 200, { changed: r.changed, features: await featuresView(ctx.tenantId) });
  });
  route('PUT', '/api/tenant/features/:key/config', { perm: 'tenant.features.manage' }, async (req, res, [key], ctx) => {
    const { config } = await json<{ config?: unknown }>(req);
    await setFeatureConfig(ctx.tenantId, key, config ?? {}, { ...actorOf(ctx), isPlatformAdmin: Boolean(ctx.user?.isPlatformAdmin) });
    send(res, 200, (await featuresView(ctx.tenantId)).find((f) => f.key === key));
  });

  // ---------- facturación y baja de la empresa (solo Propietario) ----------
  route('GET', '/api/tenant/billing', { perm: 'tenant.billing.manage' }, async (_req, res, _p, ctx) => {
    // Los cobros pendientes llevan su enlace de pago (Stripe o Mercado Pago)
    send(res, 200, { plan: ctx.plan, usage: await usageSince(ctx.tenantId, monthStart()), agents: await countAgents(ctx.tenantId), charges: dbEnabled ? await listCharges(ctx.tenantId) : [] });
  });
  route('DELETE', '/api/tenant', { perm: 'tenant.delete' }, async (req, res, _p, ctx) => {
    const { confirm } = await json<{ confirm?: string }>(req);
    if (confirm !== ctx.tenant.slug) throw fail(400, `Para eliminar la empresa escribe su identificador: ${ctx.tenant.slug}`);
    if (ctx.tenantId === DEFAULT_TENANT_ID) throw fail(400, 'La empresa Default no se puede eliminar.');
    // Baja lógica: los datos no se borran (el superadmin puede reactivarla)
    const r = await updateTenant(ctx.tenantId, { status: 'deleted' });
    invalidatePermissions(ctx.tenantId);
    await audit({ tenantId: ctx.tenantId, ...actorOf(ctx), action: 'tenant.deleted', target: `tenant:${ctx.tenantId}`, before: { status: r.before.status }, after: { status: 'deleted' } });
    send(res, 204, '');
  });

  // ---------- superadmin: empresas y planes ----------
  route('GET', '/api/platform/tenants', { platform: true }, async (_req, res) => {
    const [tenants, plans, members] = await Promise.all([listTenants(), listPlans(), dbEnabled ? memberCounts() : Promise.resolve(new Map<number, number>())]);
    const since = monthStart();
    send(res, 200, await Promise.all(tenants.map(async (t) => {
      const plan = plans.find((p) => p.id === t.planId);
      const usage = await usageSince(t.id, since);
      return { ...t, plan: plan ? { id: plan.id, name: plan.name } : null, members: members.get(t.id) ?? 0, agents: await countAgents(t.id), usage, estimatedCharge: Math.round(usage.conversations * (plan?.pricePerConversation ?? 0) * 100) / 100 };
    })));
  });
  route('POST', '/api/platform/tenants', { platform: true }, async (req, res, _p, ctx) => {
    const body = await json<{ name?: string; slug?: string; planId?: number; country?: string; ownerEmail?: string; language?: string; billingProvider?: string; billingEmail?: string; businessType?: string }>(req);
    const t = await createTenant({ name: String(body.name ?? ''), slug: body.slug || undefined, planId: Number(body.planId), country: body.country || null, language: body.language || 'es', billingProvider: body.billingProvider || null, billingEmail: body.billingEmail || body.ownerEmail || null, businessType: body.businessType || null });
    await audit({ tenantId: null, ...actorOf(ctx), action: 'tenant.created', target: `tenant:${t.id}`, after: t });
    await audit({ tenantId: t.id, ...actorOf(ctx), action: 'tenant.created', target: `tenant:${t.id}`, after: t });
    let invitation: unknown = null;
    if (body.ownerEmail) {
      const r = await invite(t.id, { email: body.ownerEmail, roleId: await systemRoleId('owner') }, { userId: ctx.user?.id ?? null, permissions: ctx.permissions }, baseUrl(req));
      await audit({ tenantId: t.id, ...actorOf(ctx), action: 'member.invited', target: `email:${r.invitation.email}`, after: { role: r.invitation.roleName, emailed: r.emailed } });
      invitation = { email: r.invitation.email, emailed: r.emailed, link: r.emailed ? null : r.link };
    }
    send(res, 201, { tenant: t, invitation });
  });
  route('PUT', '/api/platform/tenants/:id', { platform: true }, async (req, res, [id], ctx) => {
    const body = await json<{ name?: string; planId?: number; status?: 'active' | 'suspended' | 'deleted'; country?: string | null; language?: 'es' | 'en'; billingProvider?: 'stripe' | 'mercadopago' | null; billingEmail?: string | null; businessType?: string | null }>(req);
    const r = await updateTenant(Number(id), body);
    invalidatePermissions(Number(id));
    const action = body.status && body.status !== r.before.status ? (body.status === 'suspended' ? 'tenant.suspended' : body.status === 'active' ? 'tenant.reactivated' : 'tenant.deleted') : 'tenant.updated';
    await audit({ tenantId: Number(id), ...actorOf(ctx), action, target: `tenant:${id}`, before: r.before, after: r.after });
    await audit({ tenantId: null, ...actorOf(ctx), action, target: `tenant:${id}`, before: r.before, after: r.after });
    send(res, 200, r.after);
  });
  // Entrar como soporte: la sesión pasa a esa empresa (con permisos de Admin) y queda en su auditoría
  route('POST', '/api/platform/tenants/:id/support', { platform: true }, async (req, res, [id], ctx) => {
    const s = sessionOf(req);
    const t = await getTenant(Number(id));
    if (!t || t.status === 'deleted') throw fail(404, 'Empresa no encontrada');
    if (!s.tokenHash) throw fail(400, 'Sin MariaDB solo hay una empresa.');
    await setActiveTenant(s.tokenHash, t.id);
    await audit({ tenantId: t.id, actor: { type: 'superadmin', userId: ctx.user!.id }, ip: ctx.ip, action: 'support.entered', target: `user:${ctx.user!.id}`, after: { email: ctx.user!.email } });
    await audit({ tenantId: null, actor: { type: 'superadmin', userId: ctx.user!.id }, ip: ctx.ip, action: 'support.entered', target: `tenant:${t.id}` });
    send(res, 200, { tenantId: t.id });
  });
  route('POST', '/api/platform/support/exit', { platform: true }, async (req, res, _p, ctx) => {
    const s = sessionOf(req);
    if (ctx.support) await audit({ tenantId: ctx.tenantId, actor: { type: 'superadmin', userId: ctx.user!.id }, ip: ctx.ip, action: 'support.exited', target: `user:${ctx.user!.id}` });
    const own = (await membershipsOfUser(ctx.user!.id)).find((m) => m.status === 'active' && m.tenantStatus === 'active');
    if (s.tokenHash) await setActiveTenant(s.tokenHash, own?.tenantId ?? null);
    send(res, 200, { tenantId: own?.tenantId ?? null });
  });

  route('GET', '/api/platform/plans', { platform: true }, async (_req, res) => {
    send(res, 200, { plans: await listPlans(), features: FEATURES.map((f) => ({ key: f.key, name: f.name, group: f.group, toggleable: f.toggleable, scope: f.scope })), groups: GROUPS });
  });
  const planBody = async (req: IncomingMessage) => {
    const b = await json<Record<string, unknown>>(req);
    const features = Array.isArray(b.features) ? (b.features as string[]).filter((k) => getFeature(k)) : undefined;
    // Los módulos de seguridad van en todos los planes
    return { ...b, features: features ? [...new Set([...features, ...FEATURES.filter((f) => !f.toggleable).map((f) => f.key)])] : undefined } as Parameters<typeof savePlan>[0];
  };
  route('POST', '/api/platform/plans', { platform: true }, async (req, res, _p, ctx) => {
    const r = await savePlan({ ...(await planBody(req)), id: undefined });
    invalidatePermissions();
    await audit({ tenantId: null, ...actorOf(ctx), action: 'plan.created', target: `plan:${r.after.id}`, after: r.after });
    send(res, 201, r.after);
  });
  route('PUT', '/api/platform/plans/:id', { platform: true }, async (req, res, [id], ctx) => {
    const r = await savePlan({ ...(await planBody(req)), id: Number(id) });
    invalidatePermissions();
    await audit({ tenantId: null, ...actorOf(ctx), action: 'plan.updated', target: `plan:${id}`, before: r.before, after: r.after });
    send(res, 200, r.after);
  });

  // ---------- superadmin: ajustes de la plataforma (claves de IA y de cobro) ----------
  // Tú das el servicio: las claves de IA son tuyas y las usan todas las empresas.
  route('GET', '/api/platform/settings', { platform: true }, async (_req, res) => {
    send(res, 200, { settings: maskedSettings(), llm: llmStatus(), billing: billingStatus(), languages: LANGUAGES, backend: agentBackend(), jev: { configured: jevConfigured(), model: JEV_MODEL() }, claudeCode: claudeCodeStatus() });
  });
  route('PUT', '/api/platform/settings', { platform: true }, async (req, res, _p, ctx) => {
    const r = updatePlatformSettings(await json(req));
    // En la auditoría solo van los nombres de los campos que cambiaron, nunca las claves
    if (r.changed.length) await audit({ tenantId: null, ...actorOf(ctx), action: 'platform.settings_updated', target: 'platform:settings', after: { fields: r.changed } });
    send(res, 200, { changed: r.changed, settings: maskedSettings(), llm: llmStatus(), billing: billingStatus(), backend: agentBackend(), jev: { configured: jevConfigured(), model: JEV_MODEL() } });
  });
  route('POST', '/api/platform/settings/test', { platform: true }, async (req, res) => {
    const { provider } = await json<{ provider?: string }>(req);
    send(res, 200, provider === 'typesafe' ? await testJev() : await testProvider(String(provider ?? '')));
  });

  // ---------- superadmin: cobros a cada empresa ----------
  route('GET', '/api/platform/tenants/:id/charges', { platform: true }, async (_req, res, [id]) => send(res, 200, await listCharges(Number(id))));
  route('POST', '/api/platform/tenants/:id/charges', { platform: true }, async (req, res, [id], ctx) => {
    const c = await createCharge(Number(id), await json(req), ctx.user?.id ?? null, baseUrl(req));
    await audit({ tenantId: Number(id), ...actorOf(ctx), action: 'billing.charge_created', target: `charge:${c.id}`, after: { provider: c.provider, amount: c.amount, currency: c.currency, description: c.description } });
    send(res, 201, c);
  });
  route('POST', '/api/platform/tenants/:id/charges/:cid/refresh', { platform: true }, async (_req, res, [id, cid], ctx) => {
    const before = (await listCharges(Number(id))).find((c) => c.id === Number(cid));
    const c = await refreshCharge(Number(id), Number(cid));
    if (before && before.status !== c.status) await audit({ tenantId: Number(id), ...actorOf(ctx), action: 'billing.charge_paid', target: `charge:${cid}`, before: { status: before.status }, after: { status: c.status } });
    send(res, 200, c);
  });
  route('PUT', '/api/platform/tenants/:id/charges/:cid', { platform: true }, async (req, res, [id, cid], ctx) => {
    const { status } = await json<{ status?: 'paid' | 'cancelled' | 'pending' }>(req);
    const r = await setChargeStatus(Number(id), Number(cid), status!);
    await audit({ tenantId: Number(id), ...actorOf(ctx), action: 'billing.charge_status', target: `charge:${cid}`, before: { status: r.before.status }, after: { status: r.after.status } });
    send(res, 200, r.after);
  });

  // Plan y consumo de la empresa activa (para la tarjeta "Mejorar plan")
  route('GET', '/api/tenant/plan', {}, async (_req, res, _p, ctx) => {
    const plan = await planOfTenant(ctx.tenantId);
    send(res, 200, { plan: { id: plan.id, name: plan.name, maxUsers: plan.maxUsers, maxAgents: plan.maxAgents, maxConversationsMonth: plan.maxConversationsMonth } });
  });
}
