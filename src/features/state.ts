// Estado de los módulos de negocio de cada empresa y cambios (activar,
// desactivar, configurar) con todas las reglas validadas en el backend:
//
//   Plan → ¿incluido?  ·  Empresa → ¿activado?  ·  Dependencias activas  ·  Conexiones configuradas
//
// Desactivar un módulo nunca borra datos: solo bloquea el acceso. Cada cambio
// queda en la auditoría y vacía la caché de permisos al momento.
import { EventEmitter } from 'node:events';
import { dbEnabled, parseJson, tx } from '../db/pool.ts';
import { tenantDb } from '../db/tenant-db.ts';
import { FEATURES, getFeature, dependenciesOf, dependentsOf, type FeatureDef } from './registry.ts';
import { validateConfig } from './schema.ts';
import { getTenant, planOfTenant } from '../tenancy/tenants.ts';
import { connectedApps } from '../connections.ts';
import { listModules } from '../modules/registry.ts';
import { cachedFor, invalidatePermissions } from '../authz/cache.ts';
import { audit, type AuditActor } from '../tenancy/audit.ts';

export type FeatureStatus = 'active' | 'inactive' | 'needs_config' | 'not_in_plan' | 'unavailable';

export interface FeatureState {
  key: string;
  inPlan: boolean;
  enabled: boolean;
  status: FeatureStatus;
  usable: boolean; // activo, con dependencias activas y conexiones configuradas
  missingConnections: string[][]; // grupos sin ninguna app conectada
  inactiveDependencies: string[];
  config: Record<string, unknown>;
  updatedAt: string | null;
  updatedBy: number | null;
  message: string;
}

// Avisos para quien tenga trabajo en curso que pausar (flujos programados, campañas...)
export const featureEvents = new EventEmitter();

const fail = (status: number, message: string, extra: object = {}) => Object.assign(new Error(message), { status, ...extra });

// Campos obligatorios de cada app (según su definición en modules/)
function requiredFields(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of listModules()) if (m.auth) out[m.key] = m.auth.fields.filter((f) => !f.optional).map((f) => f.key);
  return out;
}

interface Row { enabled: boolean; config: Record<string, unknown>; updatedAt: string | null; updatedBy: number | null }

async function rows(tenantId: number): Promise<Map<string, Row>> {
  if (!dbEnabled) return new Map();
  const list = await tenantDb(tenantId).query('SELECT feature_key, enabled, config, updated_by, updated_at FROM tenant_features WHERE tenant_id = :tenant');
  return new Map(list.map((r: any) => [r.feature_key, { enabled: Boolean(r.enabled), config: parseJson(r.config, {}), updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null, updatedBy: r.updated_by ?? null }]));
}

async function compute(tenantId: number): Promise<Map<string, FeatureState>> {
  const [plan, tenant, saved] = await Promise.all([planOfTenant(tenantId), getTenant(tenantId), rows(tenantId)]);
  const fields = requiredFields();
  const needed = new Set(FEATURES.flatMap((f) => f.requiredConnections.flat()));
  const connected = await connectedApps(tenantId, Object.fromEntries([...needed].map((a) => [a, fields[a] ?? []])));
  const out = new Map<string, FeatureState>();

  const stateOf = (f: FeatureDef): FeatureState => {
    const done = out.get(f.key);
    if (done) return done;
    const row = saved.get(f.key);
    const inPlan = !f.toggleable || plan.features.includes(f.key);
    const enabled = !f.toggleable || (row ? row.enabled : f.defaultEnabled && inPlan);
    let config: Record<string, unknown> = row?.config ?? {};
    try { config = validateConfig(f.configSchema, config); } catch { /* se muestra tal cual; la interfaz pedirá corregirla */ }
    const missingConnections = f.requiredConnections.map((g) => (Array.isArray(g) ? g : [g])).filter((g) => !g.some((app) => connected.has(app)));
    const inactiveDependencies = f.dependsOn.filter((d) => !stateOf(getFeature(d)!).usable);
    let status: FeatureStatus;
    let message: string;
    if (!inPlan) { status = 'not_in_plan'; message = dbEnabled ? `No incluido en el plan ${plan.name}` : 'Los módulos se gestionan con MariaDB (define DB_HOST)'; }
    else if (f.countries && tenant?.country && !f.countries.includes(tenant.country)) { status = 'unavailable'; message = `Solo para empresas de ${f.countries.join(', ')}`; }
    else if (!enabled) { status = 'inactive'; message = 'Inactivo'; }
    else if (inactiveDependencies.length) { status = 'needs_config'; message = `Requiere activar: ${inactiveDependencies.map((d) => getFeature(d)!.name).join(', ')}`; }
    else if (missingConnections.length) { status = 'needs_config'; message = `Requiere conectar: ${missingConnections.map((g) => g.join(' o ')).join(', ')}`; }
    else if (f.countries && !tenant?.country) { status = 'needs_config'; message = `Indica el país de la empresa (${f.countries.join(', ')})`; }
    else { status = 'active'; message = 'Activo'; }
    const st: FeatureState = { key: f.key, inPlan, enabled, status, usable: status === 'active', missingConnections, inactiveDependencies, config, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null, message };
    out.set(f.key, st);
    return st;
  };
  for (const f of FEATURES) stateOf(f);
  return out;
}

export function tenantFeatures(tenantId: number): Promise<Map<string, FeatureState>> {
  return cachedFor(tenantId, 'features', () => compute(tenantId));
}

export async function featureState(tenantId: number, key: string): Promise<FeatureState | undefined> {
  return (await tenantFeatures(tenantId)).get(key);
}

export async function usableFeatures(tenantId: number): Promise<Set<string>> {
  return new Set([...(await tenantFeatures(tenantId)).values()].filter((s) => s.usable).map((s) => s.key));
}

// ---------- cambios ----------

export interface ChangeActor { actor: AuditActor; ip?: string | null; isPlatformAdmin: boolean }

export interface ToggleResult { changed: { key: string; enabled: boolean }[]; states: FeatureState[] }

// Activa o desactiva un módulo. Con cascade=true activa también sus dependencias
// (o desactiva los módulos que dependen de él); si no, responde 409 con la lista.
export async function setFeatureEnabled(tenantId: number, key: string, enabled: boolean, opts: { cascade?: boolean } & ChangeActor): Promise<ToggleResult> {
  if (!dbEnabled) throw fail(501, 'Los módulos se gestionan con MariaDB (define DB_HOST).');
  const f = getFeature(key);
  if (!f) throw fail(404, 'Módulo no encontrado');
  if (!f.toggleable) throw fail(400, `${f.name} es parte de la base de seguridad y no se puede desactivar.`);
  const states = await compute(tenantId); // sin caché: se decide con datos frescos
  const plan = await planOfTenant(tenantId);
  const tenant = await getTenant(tenantId);
  const assertToggle = (d: FeatureDef) => {
    if (d.scope === 'platform' && !opts.isPlatformAdmin) throw fail(403, `${d.name} solo lo puede gestionar el administrador de la plataforma.`);
  };
  assertToggle(f);
  const plan_ = (d: FeatureDef) => {
    if (!plan.features.includes(d.key)) throw fail(403, `${d.name} no está incluido en tu plan (${plan.name}). Mejora el plan para activarlo.`, { code: 'not_in_plan', feature: d.key });
    if (d.countries && tenant?.country && !d.countries.includes(tenant.country)) throw fail(403, `${d.name} solo está disponible para empresas de ${d.countries.join(', ')}.`, { code: 'unavailable', feature: d.key });
  };

  let toChange: string[];
  if (enabled) {
    plan_(f);
    const missing = dependenciesOf(key).filter((d) => !states.get(d)!.enabled);
    if (missing.length && !opts.cascade) {
      throw fail(409, `Para activar ${f.name} primero hay que activar: ${missing.map((d) => getFeature(d)!.name).join(', ')}.`, { code: 'dependencies', requires: missing });
    }
    for (const d of missing) { const def = getFeature(d)!; assertToggle(def); plan_(def); }
    toChange = [...missing, key];
  } else {
    const active = dependentsOf(key).filter((d) => states.get(d)!.enabled);
    if (active.length && !opts.cascade) {
      throw fail(409, `Hay módulos activos que dependen de ${f.name}: ${active.map((d) => getFeature(d)!.name).join(', ')}. Desactívalos también.`, { code: 'dependents', dependents: active });
    }
    for (const d of active) assertToggle(getFeature(d)!);
    toChange = [key, ...active];
  }

  const changed: { key: string; enabled: boolean }[] = [];
  await tx(async (conn) => {
    const t = tenantDb(tenantId, conn);
    for (const k of toChange) {
      if (states.get(k)!.enabled === enabled) continue;
      await t.query(
        'INSERT INTO tenant_features (tenant_id, feature_key, enabled, updated_by) VALUES (:tenant, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_by = VALUES(updated_by)',
        [k, enabled ? 1 : 0, opts.actor.userId ?? null],
      );
      changed.push({ key: k, enabled });
    }
  });
  invalidatePermissions(tenantId);
  for (const c of changed) {
    await audit({ tenantId, actor: opts.actor, ip: opts.ip, action: c.enabled ? 'feature.enabled' : 'feature.disabled', target: `feature:${c.key}`, before: { enabled: !c.enabled, status: states.get(c.key)!.status }, after: { enabled: c.enabled, cascadeFrom: c.key === key ? undefined : key } });
  }
  const disabled = changed.filter((c) => !c.enabled).map((c) => c.key);
  if (disabled.length) featureEvents.emit('disabled', { tenantId, features: disabled });
  if (changed.some((c) => c.enabled)) featureEvents.emit('enabled', { tenantId, features: changed.filter((c) => c.enabled).map((c) => c.key) });
  return { changed, states: [...(await tenantFeatures(tenantId)).values()] };
}

export async function setFeatureConfig(tenantId: number, key: string, config: unknown, opts: ChangeActor): Promise<FeatureState> {
  if (!dbEnabled) throw fail(501, 'Los módulos se gestionan con MariaDB (define DB_HOST).');
  const f = getFeature(key);
  if (!f) throw fail(404, 'Módulo no encontrado');
  if (f.scope === 'platform' && !opts.isPlatformAdmin) throw fail(403, `${f.name} solo lo puede gestionar el administrador de la plataforma.`);
  const before = (await compute(tenantId)).get(key)!;
  if (!before.inPlan) throw fail(403, `${f.name} no está incluido en tu plan.`, { code: 'not_in_plan' });
  const clean = validateConfig(f.configSchema, config);
  await tenantDb(tenantId).query(
    'INSERT INTO tenant_features (tenant_id, feature_key, enabled, config, updated_by) VALUES (:tenant, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE config = VALUES(config), updated_by = VALUES(updated_by)',
    [key, before.enabled ? 1 : 0, JSON.stringify(clean), opts.actor.userId ?? null],
  );
  invalidatePermissions(tenantId);
  await audit({ tenantId, actor: opts.actor, ip: opts.ip, action: 'feature.configured', target: `feature:${key}`, before: before.config, after: clean });
  return (await tenantFeatures(tenantId)).get(key)!;
}
