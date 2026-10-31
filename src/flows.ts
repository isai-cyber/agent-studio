// Flujos (automatizaciones): un disparador + una lista de pasos (acciones de módulos).
// Van por empresa: data/tenants/<id>/flows/<flujo>.json y cada ejecución en
// data/tenants/<id>/flows/runs/<flujo>.jsonl.
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getAgent, listAgents } from './store.ts';
import { TENANTS_DIR, tenantDataPath } from './tenancy/paths.ts';
import { chat } from './llm.ts';
import { textToSpeech } from './voice.ts';
import { flowEnv, renderDeep, type StepContext } from './modules/sdk.ts';
import { getAction, getTrigger } from './modules/registry.ts';
import { getConnection } from './connections.ts';
import { blockedFlowFeatures } from './features/enforce.ts';
import { featureEvents } from './features/state.ts';

const flowsDir = (t: number) => tenantDataPath(t, 'flows');
const flowFile = (t: number, id: string) => tenantDataPath(t, 'flows', `${safeId(id)}.json`);
const runsDir = (t: number) => tenantDataPath(t, 'flows', 'runs');
const runsFile = (t: number, id: string) => tenantDataPath(t, 'flows', 'runs', `${safeId(id)}.jsonl`);
const stateFile = (t: number) => tenantDataPath(t, 'flows', 'state.json');
const filesDir = (t: number) => tenantDataPath(t, 'files');

export interface FlowStep { id: string; module: string; key: string; name?: string; args: Record<string, unknown>; disabled?: boolean }
export interface Flow {
  id: string;
  tenantId?: number; // solo en memoria: empresa del flujo
  name: string;
  active: boolean;
  trigger: { module: string; key: string; args: Record<string, unknown> } | null;
  steps: FlowStep[];
  testPayload?: unknown; // datos de ejemplo para el botón "Probar"
  updatedAt?: string;
  // En pausa porque usa un módulo desactivado (no se borra; se reanuda al reactivarlo)
  paused?: { features: string[]; reason: string; since: string };
}
export interface RunStep { id: string; name: string; status: 'ok' | 'error' | 'omitido' | 'filtrado'; ms: number; output?: unknown; error?: string }
export interface Run { id: string; flowId: string; ts: string; source: string; status: 'ok' | 'error' | 'filtrado'; ms: number; trigger: unknown; steps: RunStep[]; blocked?: string[] }

// Bus de eventos internos (p. ej. 'agent.turn' cuando un agente responde)
export const bus = new EventEmitter();

const safeId = (id: string) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Object.assign(new Error('id de flujo inválido'), { status: 400 });
  return id;
};

const withTenant = (f: Flow, tenantId: number): Flow => {
  delete (f as Partial<Flow>).tenantId;
  Object.defineProperty(f, 'tenantId', { value: tenantId, enumerable: false, writable: false });
  return f;
};

export async function listFlows(tenantId: number): Promise<Flow[]> {
  const dir = flowsDir(tenantId);
  if (!existsSync(dir)) return [];
  const out: Flow[] = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json') || f === 'state.json') continue;
    try { out.push(withTenant(JSON.parse(await readFile(tenantDataPath(tenantId, 'flows', f), 'utf8')), tenantId)); }
    catch (err) { console.warn(`[flujos] ${tenantId}/${f}:`, (err as Error).message); }
  }
  return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export async function getFlow(tenantId: number, id: string): Promise<Flow> {
  const file = flowFile(tenantId, id);
  if (!existsSync(file)) throw Object.assign(new Error('Flujo no encontrado'), { status: 404 });
  return withTenant(JSON.parse(await readFile(file, 'utf8')), tenantId);
}

export async function saveFlow(tenantId: number, flow: Partial<Flow>): Promise<Flow> {
  const f: Flow = {
    id: flow.id ? safeId(flow.id) : randomUUID().slice(0, 8),
    name: flow.name?.trim() || 'Flujo sin nombre',
    active: Boolean(flow.active),
    trigger: flow.trigger ?? null,
    steps: (flow.steps ?? []).map((s) => ({ ...s, id: s.id || randomUUID().slice(0, 6), args: s.args ?? {} })),
    ...(flow.testPayload !== undefined ? { testPayload: flow.testPayload } : {}),
    ...(flow.paused ? { paused: flow.paused } : {}),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(flowsDir(tenantId), { recursive: true });
  await writeFile(flowFile(tenantId, f.id), JSON.stringify(f, null, 2), 'utf8');
  return withTenant(f, tenantId);
}

export async function deleteFlow(tenantId: number, id: string): Promise<void> {
  await rm(flowFile(tenantId, id), { force: true });
  await rm(runsFile(tenantId, id), { force: true });
}

export async function listRuns(tenantId: number, id: string, limit = 20): Promise<Run[]> {
  const file = runsFile(tenantId, id);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
}

// Recorta salidas grandes para el historial
function trim(value: unknown): unknown {
  const s = JSON.stringify(value ?? null);
  return s.length > 8000 ? { truncado: true, inicio: s.slice(0, 8000) } : value;
}

export function tenantOfFlow(flow: Flow): number {
  if (!flow.tenantId) throw Object.assign(new Error('Flujo sin empresa'), { status: 500 });
  return flow.tenantId;
}

function context(flow: Flow, vars: { trigger: unknown; steps: Record<string, unknown> }, args: Record<string, unknown>, logs: string[]): StepContext {
  const tenantId = tenantOfFlow(flow);
  return {
    args,
    trigger: vars.trigger,
    steps: vars.steps,
    env: flowEnv(tenantId),
    flow: { id: flow.id, name: flow.name },
    tenant: { id: tenantId },
    log: (m) => logs.push(m),
    connection: (app, fields) => getConnection(tenantId, app, fields),
    fetchJson: async (url, init) => {
      const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return body;
    },
    agentStudio: {
      chat: async (agentId, message, sessionId) => {
        const { handleTurn } = await import('./engine.ts');
        const r = await handleTurn(await getAgent(tenantId, agentId), sessionId, message, 'api');
        return { sessionId: r.sessionId, reply: r.messages.join('\n\n'), options: r.options ?? [], topic: r.topic ?? null };
      },
      listAgents: async () => (await listAgents(tenantId)).map((a) => ({ id: a.id, name: a.name })),
      llm: async (prompt, system, temperature, purpose = 'flow') => {
        const r = await chat([...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user', content: prompt }], { temperature, tenantId, purpose });
        return r.content ?? '';
      },
      tts: async (text, voiceId) => {
        const audio = await textToSpeech(text, voiceId);
        await mkdir(filesDir(tenantId), { recursive: true });
        const name = `${randomUUID()}.mp3`;
        await writeFile(tenantDataPath(tenantId, 'files', name), audio);
        return { url: `/files/${tenantId}/${name}`, bytes: audio.length };
      },
    },
    stop: (reason = 'condición no cumplida') => ({ __stop: true, reason }),
  };
}

export async function runFlow(flow: Flow, triggerPayload: unknown, source: string): Promise<Run> {
  const tenantId = tenantOfFlow(flow);
  const t0 = performance.now();
  const vars: { trigger: unknown; steps: Record<string, unknown> } = { trigger: triggerPayload ?? {}, steps: {} };
  const run: Run = { id: randomUUID().slice(0, 8), flowId: flow.id, ts: new Date().toISOString(), source, status: 'ok', ms: 0, trigger: trim(triggerPayload), steps: [] };

  // Si algún paso usa un módulo desactivado, no se ejecuta nada (ni siquiera los pasos previos)
  const blocked = await blockedFlowFeatures(tenantId, flow);
  if (blocked.length) {
    run.status = 'error';
    run.steps.push({ id: 'modulos', name: 'Comprobar módulos', status: 'error', ms: 0, error: blocked.map((b) => b.message).join(' ') });
    run.blocked = blocked.map((b) => b.feature);
  }

  for (const step of blocked.length ? [] : flow.steps) {
    const action = getAction(step.module, step.key);
    const name = step.name || `${step.module}.${step.key}`;
    // Pasos desactivados o aún sin app elegida (borrador): se omiten
    if (step.disabled || !step.module || !step.key) { run.steps.push({ id: step.id, name, status: 'omitido', ms: 0 }); continue; }
    const s0 = performance.now();
    if (!action) {
      run.steps.push({ id: step.id, name, status: 'error', ms: 0, error: `El módulo "${step.module}" o la acción "${step.key}" no está instalado` });
      run.status = 'error';
      break;
    }
    const logs: string[] = [];
    try {
      const args = renderDeep(step.args ?? {}, { ...vars, env: flowEnv(tenantId), flow: { id: flow.id, name: flow.name }, now: new Date().toISOString() }) as Record<string, unknown>;
      const out = await action.run(context(flow, vars, args, logs));
      const ms = Math.round(performance.now() - s0);
      if (out && typeof out === 'object' && (out as { __stop?: boolean }).__stop) {
        run.steps.push({ id: step.id, name, status: 'filtrado', ms, output: { motivo: (out as { reason: string }).reason } });
        run.status = 'filtrado';
        break;
      }
      vars.steps[step.id] = out;
      run.steps.push({ id: step.id, name, status: 'ok', ms, output: trim(logs.length ? { resultado: out, registro: logs } : out) });
    } catch (err) {
      run.steps.push({ id: step.id, name, status: 'error', ms: Math.round(performance.now() - s0), error: (err as Error).message });
      run.status = 'error';
      break;
    }
  }
  run.ms = Math.round(performance.now() - t0);
  await mkdir(runsDir(tenantId), { recursive: true });
  await appendFile(runsFile(tenantId, flow.id), `${JSON.stringify(run)}\n`, 'utf8');
  return run;
}

// ---------- disparadores automáticos ----------

// Empresas con datos en disco. Las suspendidas o eliminadas se saltan (lo decide
// isTenantActive, que conecta server.ts con la base de datos).
function tenantIds(): number[] {
  if (!existsSync(TENANTS_DIR)) return [];
  return readdirSync(TENANTS_DIR).filter((d) => /^[1-9]\d*$/.test(d)).map(Number);
}
let isTenantActive: (tenantId: number) => Promise<boolean> = async () => true;
export function setTenantFilter(fn: (tenantId: number) => Promise<boolean>): void {
  isTenantActive = fn;
}

async function readState(tenantId: number): Promise<Record<string, { last?: number; seen?: string[] }>> {
  try { return JSON.parse(await readFile(stateFile(tenantId), 'utf8')); } catch { return {}; }
}

// Los flujos programados que usan un módulo desactivado quedan en pausa (no se
// borran) y se reanudan solos al reactivarlo.
export async function syncPausedFlows(tenantId: number): Promise<{ paused: string[]; resumed: string[] }> {
  const out = { paused: [] as string[], resumed: [] as string[] };
  for (const flow of await listFlows(tenantId)) {
    const trig = flow.trigger ? getTrigger(flow.trigger.module, flow.trigger.key) : undefined;
    const scheduled = trig?.type === 'schedule' || trig?.type === 'poll';
    const blocked = flow.active && scheduled ? await blockedFlowFeatures(tenantId, flow) : [];
    if (blocked.length && !flow.paused) {
      flow.paused = { features: blocked.map((b) => b.feature), reason: blocked.map((b) => b.message).join(' '), since: new Date().toISOString() };
      await saveFlow(tenantId, flow);
      out.paused.push(flow.id);
    } else if (!blocked.length && flow.paused) {
      delete flow.paused;
      await saveFlow(tenantId, flow);
      out.resumed.push(flow.id);
    }
  }
  return out;
}

async function tickTenant(tenantId: number, now: number): Promise<void> {
  const state = await readState(tenantId);
  await syncPausedFlows(tenantId);
  for (const flow of await listFlows(tenantId)) {
    if (!flow.active || !flow.trigger || flow.paused) continue;
    const trig = getTrigger(flow.trigger.module, flow.trigger.key);
    if (!trig || (trig.type !== 'schedule' && trig.type !== 'poll')) continue;
    const every = Math.max(1, Number(flow.trigger.args?.everyMinutes ?? 15));
    const st = (state[flow.id] ??= {});
    if (st.last && now - st.last < every * 60_000) continue;
    st.last = now;
    if (trig.type === 'schedule') {
      void runFlow(flow, { programado: new Date(now).toISOString() }, 'programado').catch((err) => console.warn(`[flujos] ${tenantId}/${flow.id}:`, err.message));
    } else if (trig.run) {
      try {
        const args = renderDeep(flow.trigger.args ?? {}, { env: flowEnv(tenantId) }) as Record<string, unknown>;
        const items = await trig.run(context(flow, { trigger: {}, steps: {} }, args, []));
        const seen = new Set(st.seen ?? []);
        const fresh = items.filter((i) => !seen.has(String(i.id)));
        // La primera vez solo se memorizan, para no disparar con lo antiguo
        if (st.seen) for (const item of fresh) await runFlow(flow, item, 'sondeo');
        st.seen = [...new Set([...items.map((i) => String(i.id)), ...(st.seen ?? [])])].slice(0, 500);
      } catch (err) {
        console.warn(`[flujos] sondeo ${tenantId}/${flow.id}:`, (err as Error).message);
      }
    }
  }
  await mkdir(flowsDir(tenantId), { recursive: true });
  await writeFile(stateFile(tenantId), JSON.stringify(state), 'utf8');
}

let ticking = false;
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const tenantId of tenantIds()) {
      try {
        if (await isTenantActive(tenantId)) await tickTenant(tenantId, now);
      } catch (err) {
        console.warn(`[flujos] empresa ${tenantId}:`, (err as Error).message);
      }
    }
  } finally {
    ticking = false;
  }
}

export function startScheduler(): void {
  setInterval(() => void tick(), 30_000).unref();
  // Al desactivar o reactivar un módulo, los flujos programados se pausan o reanudan al momento
  const resync = (e: { tenantId: number }) => void syncPausedFlows(e.tenantId).catch((err) => console.warn('[flujos] pausa:', err.message));
  featureEvents.on('disabled', resync);
  featureEvents.on('enabled', resync);
  // Eventos internos: cada vez que un agente responde (solo flujos de su empresa)
  bus.on('agent.turn', async (e: { tenantId: number; agentId: string; topic?: string | null }) => {
    try {
      if (!(await isTenantActive(e.tenantId))) return;
      for (const flow of await listFlows(e.tenantId)) {
        if (!flow.active || !flow.trigger) continue;
        const trig = getTrigger(flow.trigger.module, flow.trigger.key);
        if (trig?.type !== 'event' || trig.event !== 'agent.turn') continue;
        const a = flow.trigger.args ?? {};
        if (a.agentId && a.agentId !== e.agentId) continue;
        if (a.topic && String(a.topic).toLowerCase() !== String(e.topic ?? '').toLowerCase()) continue;
        void runFlow(flow, e, 'evento').catch((err) => console.warn(`[flujos] ${e.tenantId}/${flow.id}:`, err.message));
      }
    } catch (err) {
      console.warn('[flujos] agent.turn:', (err as Error).message);
    }
  });
}
