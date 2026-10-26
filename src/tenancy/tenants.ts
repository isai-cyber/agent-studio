// Empresas (tenants) y planes. Lectura con caché corta; las escrituras invalidan.
// Sin MariaDB solo existe la empresa Default.
import { db, dbEnabled } from '../db/pool.ts';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG } from './paths.ts';
import { slugify } from '../store.ts';

export type TenantStatus = 'active' | 'suspended' | 'deleted';

export interface Plan {
  id: number;
  key: string;
  name: string;
  maxConversationsMonth: number | null;
  maxUsers: number | null;
  maxAgents: number | null;
  maxCampaignMessages: number | null;
  pricePerConversation: number;
  features: string[];
}

export interface Tenant { id: number; name: string; slug: string; planId: number; status: TenantStatus; country: string | null; createdAt?: string }

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// Empresa Default cuando no hay base de datos (todo en un solo espacio, como antes)
export const LOCAL_TENANT: Tenant = { id: DEFAULT_TENANT_ID, name: 'Default', slug: DEFAULT_TENANT_SLUG, planId: 0, status: 'active', country: null };
export const LOCAL_PLAN: Plan = { id: 0, key: 'local', name: 'Instalación local', maxConversationsMonth: null, maxUsers: null, maxAgents: null, maxCampaignMessages: null, pricePerConversation: 0, features: [] };

const TTL = 30_000;
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function invalidateTenants(): void {
  cache.clear();
}

const rowToTenant = (r: any): Tenant => ({ id: r.id, name: r.name, slug: r.slug, planId: r.plan_id, status: r.status, country: r.country ?? null, createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined });

export async function getTenant(id: number): Promise<Tenant | null> {
  if (!dbEnabled) return id === DEFAULT_TENANT_ID ? LOCAL_TENANT : null;
  return cached(`t:${id}`, async () => {
    const rows = await db().query('SELECT * FROM tenants WHERE id = ?', [id]);
    return rows[0] ? rowToTenant(rows[0]) : null;
  });
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) return null;
  if (!dbEnabled) return slug === DEFAULT_TENANT_SLUG ? LOCAL_TENANT : null;
  return cached(`s:${slug}`, async () => {
    const rows = await db().query('SELECT * FROM tenants WHERE slug = ?', [slug]);
    return rows[0] ? rowToTenant(rows[0]) : null;
  });
}

export async function tenantSlug(id: number): Promise<string> {
  const t = await getTenant(id);
  if (!t) throw fail(404, 'Empresa no encontrada');
  return t.slug;
}

export async function isTenantActive(id: number): Promise<boolean> {
  return (await getTenant(id))?.status === 'active';
}

const rowToPlan = (r: any, features: string[]): Plan => ({
  id: r.id, key: r.plan_key, name: r.name,
  maxConversationsMonth: r.max_conversations_month ?? null, maxUsers: r.max_users ?? null, maxAgents: r.max_agents ?? null,
  maxCampaignMessages: r.max_campaign_messages ?? null, pricePerConversation: Number(r.price_per_conversation ?? 0), features,
});

export async function listPlans(): Promise<Plan[]> {
  if (!dbEnabled) return [LOCAL_PLAN];
  return cached('plans', async () => {
    const plans = await db().query('SELECT * FROM plans ORDER BY id');
    const feats = await db().query('SELECT plan_id, feature_key FROM plan_features');
    return plans.map((p: any) => rowToPlan(p, feats.filter((f: any) => f.plan_id === p.id).map((f: any) => f.feature_key)));
  });
}

export async function getPlan(id: number): Promise<Plan | null> {
  return (await listPlans()).find((p) => p.id === id) ?? null;
}

export async function planOfTenant(tenantId: number): Promise<Plan> {
  const t = await getTenant(tenantId);
  if (!t) throw fail(404, 'Empresa no encontrada');
  return (await getPlan(t.planId)) ?? LOCAL_PLAN;
}

// ---------- gestión (superadmin) ----------

export async function listTenants(): Promise<Tenant[]> {
  if (!dbEnabled) return [LOCAL_TENANT];
  return (await db().query("SELECT * FROM tenants WHERE status <> 'deleted' ORDER BY id")).map(rowToTenant);
}

export async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name).slice(0, 50) || 'empresa';
  let slug = base;
  for (let n = 2; await getTenantBySlug(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export async function createTenant(input: { name: string; slug?: string; planId: number; country?: string | null }): Promise<Tenant> {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 120) throw fail(400, 'Escribe el nombre de la empresa (máximo 120 caracteres).');
  const slug = input.slug ? String(input.slug).trim().toLowerCase() : await uniqueSlug(name);
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(slug)) throw fail(400, 'El identificador (slug) solo admite minúsculas, números y guiones.');
  if (await getTenantBySlug(slug)) throw fail(409, `Ya existe una empresa con el identificador "${slug}".`);
  if (!(await getPlan(Number(input.planId)))) throw fail(400, 'Elige un plan válido.');
  const country = input.country ? String(input.country).toUpperCase() : null;
  if (country && !/^[A-Z]{2}$/.test(country)) throw fail(400, 'El país debe ser un código de 2 letras (p. ej. MX).');
  const r = await db().query('INSERT INTO tenants (name, slug, plan_id, country) VALUES (?, ?, ?, ?)', [name, slug, Number(input.planId), country]);
  invalidateTenants();
  return (await getTenant(r.insertId))!;
}

export async function updateTenant(id: number, patch: Partial<Pick<Tenant, 'name' | 'planId' | 'status' | 'country'>>): Promise<{ before: Tenant; after: Tenant }> {
  const before = await getTenant(id);
  if (!before) throw fail(404, 'Empresa no encontrada');
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) { const n = String(patch.name).trim(); if (!n || n.length > 120) throw fail(400, 'Nombre no válido'); sets.push('name = ?'); params.push(n); }
  if (patch.planId !== undefined) { if (!(await getPlan(Number(patch.planId)))) throw fail(400, 'Plan no válido'); sets.push('plan_id = ?'); params.push(Number(patch.planId)); }
  if (patch.status !== undefined) {
    if (!['active', 'suspended', 'deleted'].includes(patch.status)) throw fail(400, 'Estado no válido');
    if (id === DEFAULT_TENANT_ID && patch.status === 'deleted') throw fail(400, 'La empresa Default no se puede eliminar');
    sets.push('status = ?'); params.push(patch.status);
  }
  if (patch.country !== undefined) { const c = patch.country ? String(patch.country).toUpperCase() : null; if (c && !/^[A-Z]{2}$/.test(c)) throw fail(400, 'País no válido'); sets.push('country = ?'); params.push(c); }
  if (sets.length) await db().query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  invalidateTenants();
  return { before, after: (await getTenant(id))! };
}

export async function savePlan(input: Partial<Plan> & { name: string }): Promise<{ before: Plan | null; after: Plan }> {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 80) throw fail(400, 'Nombre de plan no válido');
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.floor(Number(v))));
  const vals = [name, num(input.maxConversationsMonth), num(input.maxUsers), num(input.maxAgents), num(input.maxCampaignMessages), Math.max(0, Number(input.pricePerConversation ?? 0))];
  const before = input.id ? await getPlan(input.id) : null;
  let id = input.id;
  if (id) {
    if (!before) throw fail(404, 'Plan no encontrado');
    await db().query('UPDATE plans SET name = ?, max_conversations_month = ?, max_users = ?, max_agents = ?, max_campaign_messages = ?, price_per_conversation = ? WHERE id = ?', [...vals, id]);
  } else {
    const key = String(input.key ?? slugify(name)).replace(/-/g, '_').slice(0, 40);
    const r = await db().query('INSERT INTO plans (name, max_conversations_month, max_users, max_agents, max_campaign_messages, price_per_conversation, plan_key) VALUES (?, ?, ?, ?, ?, ?, ?)', [...vals, key]);
    id = r.insertId;
  }
  if (input.features) {
    await db().query('DELETE FROM plan_features WHERE plan_id = ?', [id]);
    for (const f of new Set(input.features)) await db().query('INSERT INTO plan_features (plan_id, feature_key) VALUES (?, ?)', [id, f]);
  }
  invalidateTenants();
  return { before, after: (await getPlan(id!))! };
}

