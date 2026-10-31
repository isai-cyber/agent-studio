// Aplicación de los módulos activables fuera de /api: herramientas del agente,
// pasos de automatización y webhooks. Todo pasa por el estado de src/features/state.ts.
//
// Los módulos registran aquí su lógica cuando se implementen:
//   registerAgentTool('crm', { name: 'crm_lookup_contact', description, parameters, run })
// El nombre debe estar en `agentTools` del registro; si el módulo no está activo
// y configurado, la herramienta no llega al LLM y, si el modelo la pide igual,
// se rechaza y queda en la auditoría.
import type { ToolSpec } from '../llm.ts';
import { FEATURES, featureForAgentTool, featureForFlowStep, getFeature } from './registry.ts';
import { tenantFeatures } from './state.ts';
import { audit } from '../tenancy/audit.ts';

export interface AgentToolImpl {
  name: string;
  description: string;
  parameters: object;
  run: (call: { tenantId: number; agentId: string; sessionId: string; args: Record<string, unknown> }) => Promise<unknown>;
}

const tools = new Map<string, { feature: string; impl: AgentToolImpl }>();

export function registerAgentTool(feature: string, impl: AgentToolImpl): void {
  const f = getFeature(feature);
  if (!f) throw new Error(`registerAgentTool: el módulo "${feature}" no existe`);
  if (!f.agentTools.includes(impl.name)) throw new Error(`registerAgentTool: "${impl.name}" no está en agentTools de ${feature}`);
  tools.set(impl.name, { feature, impl });
}

// Solo para las pruebas
export function clearAgentTools(): void {
  tools.clear();
}

// Herramientas de módulos que ve el LLM: solo las de módulos activos y configurados
export async function featureToolsFor(tenantId: number): Promise<ToolSpec[]> {
  const states = await tenantFeatures(tenantId);
  return [...tools.values()]
    .filter((t) => states.get(t.feature)?.usable)
    .map((t) => ({ type: 'function' as const, function: { name: t.impl.name, description: t.impl.description, parameters: t.impl.parameters } }));
}

export function isFeatureTool(name: string): boolean {
  return Boolean(featureForAgentTool(name));
}

// Ejecuta una herramienta de módulo pedida por el modelo, comprobando de nuevo
// que el módulo sigue activo (pudo desactivarse en mitad de la conversación)
export async function runFeatureTool(call: { tenantId: number; agentId: string; sessionId: string; name: string; args: Record<string, unknown> }): Promise<string> {
  const f = featureForAgentTool(call.name)!;
  const st = (await tenantFeatures(call.tenantId)).get(f.key);
  const t = tools.get(call.name);
  if (!st?.usable || !t) {
    await audit({
      tenantId: call.tenantId, actor: { type: 'system' }, action: 'agent.tool_blocked', target: `agent:${call.agentId}`,
      after: { tool: call.name, feature: f.key, status: st?.status ?? 'sin implementar', session: call.sessionId },
    });
    return JSON.stringify({ error: `La herramienta ${call.name} no está disponible: el módulo ${f.name} ${st?.usable ? 'aún no está implementado' : 'está desactivado o requiere configuración'}.` });
  }
  try {
    return JSON.stringify(await t.impl.run({ tenantId: call.tenantId, agentId: call.agentId, sessionId: call.sessionId, args: call.args }));
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

// ---------- automatizaciones ----------

interface StepLike { module: string; key: string; disabled?: boolean }

// Módulos de negocio que bloquean un flujo (disparador o algún paso activo)
export async function blockedFlowFeatures(tenantId: number, flow: { trigger: StepLike | null; steps: StepLike[] }): Promise<{ feature: string; message: string }[]> {
  const states = await tenantFeatures(tenantId);
  const out = new Map<string, string>();
  for (const s of [...(flow.trigger ? [flow.trigger] : []), ...flow.steps.filter((x) => !x.disabled)]) {
    if (!s.module) continue;
    const f = featureForFlowStep(s.module, s.key);
    if (!f) continue;
    const st = states.get(f.key);
    if (!st?.usable) out.set(f.key, `El flujo usa el módulo ${f.name}, que ${st?.status === 'not_in_plan' ? 'no está incluido en tu plan' : st?.enabled ? 'requiere configuración' : 'está desactivado'}.`);
  }
  return [...out].map(([feature, message]) => ({ feature, message }));
}

// La paleta del editor solo muestra los pasos de módulos activos
export async function filterModulesForTenant<M extends { key: string; actions: { key: string }[]; triggers: { key: string }[] }>(tenantId: number, mods: M[]): Promise<M[]> {
  const gated = new Set(FEATURES.flatMap((f) => f.flowModules.map((p) => p.split('.')[0])));
  if (!mods.some((m) => gated.has(m.key))) return mods;
  const states = await tenantFeatures(tenantId);
  const ok = (m: string, a: string) => { const f = featureForFlowStep(m, a); return !f || Boolean(states.get(f.key)?.usable); };
  return mods.flatMap((m) => {
    if (!gated.has(m.key)) return [m];
    const actions = m.actions.filter((a) => ok(m.key, a.key));
    const triggers = m.triggers.filter((t) => ok(m.key, t.key));
    return actions.length || triggers.length ? [{ ...m, actions, triggers }] : [];
  });
}
