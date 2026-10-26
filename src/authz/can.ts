// Punto único de decisión: ¿puede este contexto usar esta función?
//
//   can(ctx, { feature: 'crm', permission: 'crm.contacts.write' })
//
// Se comprueba en este orden y se corta en la primera regla que falle:
//   0. La empresa está activa (no suspendida ni eliminada).
//   1. Plan: el módulo está incluido en el plan de la empresa.
//   2. Empresa: el admin lo activó.
//   3. Rol: el usuario (o la clave de API) tiene el permiso.
//   4. Dependencias: los módulos de los que depende están activos y sus
//      conexiones configuradas ("Requiere configuración").
// Lo usan /api, /v1, /mcp, las herramientas del agente, los flujos y los webhooks.
import type { Ctx } from './context.ts';
import { getFeature } from '../features/registry.ts';
import { featureState } from '../features/state.ts';

export type DenyCode = 'tenant_inactive' | 'unknown_feature' | 'not_in_plan' | 'unavailable' | 'feature_disabled' | 'permission' | 'needs_config';

export type Decision = { ok: true } | { ok: false; code: DenyCode; status: number; message: string };

const deny = (code: DenyCode, message: string, status = 403): Decision => ({ ok: false, code, status, message });

export async function can(ctx: Ctx, req: { feature?: string; permission?: string }): Promise<Decision> {
  if (ctx.tenant.status !== 'active' && !ctx.support) return deny('tenant_inactive', ctx.tenant.status === 'suspended' ? 'La empresa está suspendida. Contacta con el administrador de la plataforma.' : 'La empresa no existe.');
  if (req.feature) {
    const def = getFeature(req.feature);
    if (!def) return deny('unknown_feature', `Módulo desconocido: ${req.feature}`, 404);
    const st = await featureState(ctx.tenantId, req.feature);
    if (!st) return deny('unknown_feature', `Módulo desconocido: ${req.feature}`, 404);
    if (!st.inPlan) return deny('not_in_plan', `${def.name} no está incluido en tu plan.`);
    if (st.status === 'unavailable') return deny('unavailable', `${def.name}: ${st.message}.`);
    if (!st.enabled) return deny('feature_disabled', `${def.name} está desactivado en tu empresa.`);
    if (req.permission && !ctx.permissions.has(req.permission)) return deny('permission', `No tienes permiso para esto (${req.permission}).`);
    if (!st.usable) return deny('needs_config', `${def.name} requiere configuración: ${st.message}.`);
    return { ok: true };
  }
  if (req.permission && !ctx.permissions.has(req.permission)) return deny('permission', `No tienes permiso para esto (${req.permission}).`);
  return { ok: true };
}

// Igual que can(), pero lanza un error HTTP si no se puede
export async function assertCan(ctx: Ctx, req: { feature?: string; permission?: string }): Promise<void> {
  const d = await can(ctx, req);
  if (!d.ok) throw Object.assign(new Error(d.message), { status: d.status, code: d.code });
}
