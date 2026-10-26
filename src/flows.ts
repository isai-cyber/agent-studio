// Flujos (automatizaciones): un disparador + una lista de pasos (acciones de módulos).
// Se guardan en data/flows/<id>.json y cada ejecución en data/flows/runs/<id>.jsonl.
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, getAgent, listAgents } from './store.ts';
import { chat } from './llm.ts';
import { textToSpeech } from './voice.ts';
import { flowEnv, renderDeep, type StepContext } from './modules/sdk.ts';
import { getAction, getTrigger } from './modules/registry.ts';
import { getConnection } from './connections.ts';

const DIR = join(ROOT, 'data', 'flows');
const RUNS = join(DIR, 'runs');
const FILES = join(ROOT, 'data', 'files');
const STATE = join(DIR, 'state.json');

export interface FlowStep { id: string; module: string; key: string; name?: string; args: Record<string, unknown>; disabled?: boolean }
export interface Flow {
  id: string;
  name: string;
  active: boolean;
  trigger: { module: string; key: string; args: Record<string, unknown> } | null;
  steps: FlowStep[];
  testPayload?: unknown; // datos de ejemplo para el botón "Probar"
  updatedAt?: string;
}
export interface RunStep { id: string; name: string; status: 'ok' | 'error' | 'omitido' | 'filtrado'; ms: number; output?: unknown; error?: string }
export interface Run { id: string; flowId: string; ts: string; source: string; status: 'ok' | 'error' | 'filtrado'; ms: number; trigger: unknown; steps: RunStep[] }

// Bus de eventos internos (p. ej. 'agent.turn' cuando un agente responde)
export const bus = new EventEmitter();

const safeId = (id: string) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Object.assign(new Error('id de flujo inválido'), { status: 400 });
  return id;
};

export async function listFlows(): Promise<Flow[]> {
  if (!existsSync(DIR)) return [];
  const out: Flow[] = [];
  for (const f of await readdir(DIR)) if (f.endsWith('.json') && f !== 'state.json') out.push(JSON.parse(await readFile(join(DIR, f), 'utf8')));
  return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export async function getFlow(id: string): Promise<Flow> {
  const file = join(DIR, `${safeId(id)}.json`);
  if (!existsSync(file)) throw Object.assign(new Error('Flujo no encontrado'), { status: 404 });
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function saveFlow(flow: Partial<Flow>): Promise<Flow> {
  const f: Flow = {
    id: flow.id ? safeId(flow.id) : randomUUID().slice(0, 8),
    name: flow.name?.trim() || 'Flujo sin nombre',
    active: Boolean(flow.active),
    trigger: flow.trigger ?? null,
    steps: (flow.steps ?? []).map((s) => ({ ...s, id: s.id || randomUUID().slice(0, 6), args: s.args ?? {} })),
    ...(flow.testPayload !== undefined ? { testPayload: flow.testPayload } : {}),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${f.id}.json`), JSON.stringify(f, null, 2), 'utf8');
  return f;
}

export async function deleteFlow(id: string): Promise<void> {
  await rm(join(DIR, `${safeId(id)}.json`), { force: true });
  await rm(join(RUNS, `${safeId(id)}.jsonl`), { force: true });
}

export async function listRuns(id: string, limit = 20): Promise<Run[]> {
  const file = join(RUNS, `${safeId(id)}.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
}

// Recorta salidas grandes para el historial
function trim(value: unknown): unknown {
  const s = JSON.stringify(value ?? null);
  return s.length > 8000 ? { truncado: true, inicio: s.slice(0, 8000) } : value;
}

function context(flow: Flow, vars: { trigger: unknown; steps: Record<string, unknown> }, args: Record<string, unknown>, logs: string[]): StepContext {
  return {
    args,
    trigger: vars.trigger,
    steps: vars.steps,
    env: flowEnv(),
    flow: { id: flow.id, name: flow.name },
    log: (m) => logs.push(m),
    connection: (app, fields) => getConnection(app, fields),
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
        const r = await handleTurn(await getAgent(agentId), sessionId, message, 'api');
        return { sessionId: r.sessionId, reply: r.messages.join('\n\n'), options: r.options ?? [], topic: r.topic ?? null };
      },
      listAgents: async () => (await listAgents()).map((a) => ({ id: a.id, name: a.name })),
      llm: async (prompt, system, temperature) => {
        const r = await chat([...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user', content: prompt }], { temperature });
        return r.content ?? '';
      },
      tts: async (text, voiceId) => {
        const audio = await textToSpeech(text, voiceId);
        await mkdir(FILES, { recursive: true });
        const name = `${randomUUID()}.mp3`;
        await writeFile(join(FILES, name), audio);
        return { url: `/files/${name}`, bytes: audio.length };
      },
    },
    stop: (reason = 'condición no cumplida') => ({ __stop: true, reason }),
  };
}

export async function runFlow(flow: Flow, triggerPayload: unknown, source: string): Promise<Run> {
  const t0 = performance.now();
  const vars: { trigger: unknown; steps: Record<string, unknown> } = { trigger: triggerPayload ?? {}, steps: {} };
  const run: Run = { id: randomUUID().slice(0, 8), flowId: flow.id, ts: new Date().toISOString(), source, status: 'ok', ms: 0, trigger: trim(triggerPayload), steps: [] };

  for (const step of flow.steps) {
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
      const args = renderDeep(step.args ?? {}, { ...vars, env: flowEnv(), flow: { id: flow.id, name: flow.name }, now: new Date().toISOString() }) as Record<string, unknown>;
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
  await mkdir(RUNS, { recursive: true });
  await appendFile(join(RUNS, `${flow.id}.jsonl`), `${JSON.stringify(run)}\n`, 'utf8');
  return run;
}

// ---------- disparadores automáticos ----------

async function readState(): Promise<Record<string, { last?: number; seen?: string[] }>> {
  try { return JSON.parse(await readFile(STATE, 'utf8')); } catch { return {}; }
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const state = await readState();
    const now = Date.now();
    for (const flow of await listFlows()) {
      if (!flow.active || !flow.trigger) continue;
      const trig = getTrigger(flow.trigger.module, flow.trigger.key);
      if (!trig || (trig.type !== 'schedule' && trig.type !== 'poll')) continue;
      const every = Math.max(1, Number(flow.trigger.args?.everyMinutes ?? 15));
      const st = (state[flow.id] ??= {});
      if (st.last && now - st.last < every * 60_000) continue;
      st.last = now;
      if (trig.type === 'schedule') {
        void runFlow(flow, { programado: new Date(now).toISOString() }, 'programado');
      } else if (trig.run) {
        try {
          const args = renderDeep(flow.trigger.args ?? {}, { env: flowEnv() }) as Record<string, unknown>;
          const items = await trig.run(context(flow, { trigger: {}, steps: {} }, args, []));
          const seen = new Set(st.seen ?? []);
          const fresh = items.filter((i) => !seen.has(String(i.id)));
          // La primera vez solo se memorizan, para no disparar con lo antiguo
          if (st.seen) for (const item of fresh) await runFlow(flow, item, 'sondeo');
          st.seen = [...new Set([...items.map((i) => String(i.id)), ...(st.seen ?? [])])].slice(0, 500);
        } catch (err) {
          console.warn(`[flujos] sondeo ${flow.id}:`, (err as Error).message);
        }
      }
    }
    await mkdir(DIR, { recursive: true });
    await writeFile(STATE, JSON.stringify(state), 'utf8');
  } finally {
    ticking = false;
  }
}

export function startScheduler(): void {
  setInterval(() => void tick(), 30_000).unref();
  // Eventos internos: cada vez que un agente responde
  bus.on('agent.turn', async (e: { agentId: string; topic?: string | null }) => {
    for (const flow of await listFlows()) {
      if (!flow.active || !flow.trigger) continue;
      const trig = getTrigger(flow.trigger.module, flow.trigger.key);
      if (trig?.type !== 'event' || trig.event !== 'agent.turn') continue;
      const a = flow.trigger.args ?? {};
      if (a.agentId && a.agentId !== e.agentId) continue;
      if (a.topic && String(a.topic).toLowerCase() !== String(e.topic ?? '').toLowerCase()) continue;
      void runFlow(flow, e, 'evento');
    }
  });
}
