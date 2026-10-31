// Agrega los eventos de métricas para el panel y genera datos de ejemplo.
import type { MetricEvent, TurnEvent, TtsEvent, LlmEvent, ModelUse } from './metrics.ts';
import { PRICES } from './metrics.ts';
import { parseModel, priceOf, costOf } from './llm-providers.ts';
import { defaultModelSpec } from './llm.ts';
import type { AgentDef } from './types.ts';

export type Range = '24h' | '7d' | '30d';
const RANGE_MS: Record<Range, number> = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };

// Hasta 5 agentes con color propio (paleta validada); el resto se agrupa en "Otros"
const MAX_SLOTS = 5;
// En la dispersión (todos los pares a la vista) solo 3 colores son distinguibles
const SCATTER_SLOTS = 3;

export const STEP_LABELS: Record<string, string> = {
  clasificar: 'Clasificar tema',
  conocimiento: 'Buscar conocimiento',
  llm: 'Modelo de lenguaje',
  modulo: 'Módulos de negocio',
  accion: 'Acciones / herramientas',
  mcp: 'Servidores MCP',
  'claude-code': 'Claude Code',
  nanoclaw: 'NanoClaw (antiguo)',
  voz: 'Voz (ElevenLabs)',
  motor: 'Motor y red',
};
const STEP_ORDER = ['clasificar', 'conocimiento', 'llm', 'accion', 'mcp', 'modulo', 'claude-code', 'nanoclaw', 'motor', 'voz'];

const SYSTEM_TOPICS = /^(saludo|greeting|goodbye|thank you|start over|reset conversation|end of conversation)$/i;
const ESCALATION = /escal|humano|persona|human|agent/i;
export const OUTCOMES = ['Flujo guiado', 'Respuesta libre', 'Escalado', 'Abandonada'] as const;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const totalTokens = (e: TurnEvent) => e.tokens.input + e.tokens.output;

export function aggregate(all: MetricEvent[], agentsList: AgentDef[], range: Range, demo: boolean) {
  const now = Date.now();
  const since = now - RANGE_MS[range];
  const inRange = all.filter((e) => Date.parse(e.ts) >= since);
  const turns = inRange.filter((e): e is TurnEvent => e.type === 'turn');
  const tts = inRange.filter((e): e is TtsEvent => e.type === 'tts');
  const llmCalls = inRange.filter((e): e is LlmEvent => e.type === 'llm');

  // --- coste y tokens por modelo ("proveedor:modelo"), conversaciones y flujos juntos
  const perModel = new Map<string, ModelUse>();
  for (const e of [...turns, ...llmCalls]) {
    for (const [model, u] of Object.entries(e.models ?? {})) {
      const m = perModel.get(model) ?? { calls: 0, input: 0, cacheHit: 0, output: 0, costUsd: 0 };
      m.calls += u.calls; m.input += u.input; m.cacheHit += u.cacheHit; m.output += u.output; m.costUsd += u.costUsd;
      perModel.set(model, m);
    }
  }
  const byModel = [...perModel].map(([model, u]) => ({ model, ...u, costUsd: Math.round(u.costUsd * 1e6) / 1e6 })).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  // --- identidad y color de cada agente: estable (orden alfabético del id), nunca por ranking
  const names = new Map(agentsList.map((a) => [a.id, a.name]));
  const allIds = [...new Set([...agentsList.map((a) => a.id), ...all.filter((e) => e.type === 'turn').map((e) => (e as TurnEvent).agentId)])].sort();
  const active = new Set(turns.map((t) => t.agentId));
  const activeSorted = allIds.filter((id) => active.has(id));
  // Los 5 agentes con más tokens en el rango tienen color; su slot depende del orden alfabético
  const byTokens = [...activeSorted].sort(
    (a, b) => turns.filter((t) => t.agentId === b).reduce((s, t) => s + totalTokens(t), 0) - turns.filter((t) => t.agentId === a).reduce((s, t) => s + totalTokens(t), 0),
  );
  const colored = new Set(byTokens.slice(0, MAX_SLOTS));
  const slotted = activeSorted.filter((id) => colored.has(id));
  const agents = activeSorted.map((id) => ({ id, name: names.get(id) ?? id, slot: slotted.includes(id) ? slotted.indexOf(id) : null }));
  const keyOf = (id: string) => (colored.has(id) ? id : 'otros');

  // --- 1. tokens en el tiempo (área apilada por agente)
  const hourly = range === '24h';
  const bucketMs = hourly ? 36e5 : 864e5;
  const start = hourly ? Math.floor(since / 36e5) * 36e5 + 36e5 : new Date(new Date(since + 864e5).toDateString()).getTime();
  const buckets: number[] = [];
  for (let t = start; t <= now; t += bucketMs) buckets.push(t);
  const idx = (ts: string) => Math.min(buckets.length - 1, Math.max(0, Math.floor((Date.parse(ts) - start) / bucketMs)));
  const seriesKeys = [...slotted, ...(activeSorted.some((id) => !colored.has(id)) ? ['otros'] : [])];
  const series = seriesKeys.map((key) => {
    const input = buckets.map(() => 0);
    const output = buckets.map(() => 0);
    for (const t of turns) {
      if (keyOf(t.agentId) !== key || Date.parse(t.ts) < start) continue;
      input[idx(t.ts)] += t.tokens.input;
      output[idx(t.ts)] += t.tokens.output;
    }
    return { key, name: key === 'otros' ? 'Otros' : (names.get(key) ?? key), slot: key === 'otros' ? null : slotted.indexOf(key), input, output, total: input.map((v, i) => v + output[i]) };
  });

  // --- 2. coste acumulado del mes en curso frente al presupuesto
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const today = d.getDate();
  const daily = Array.from({ length: daysInMonth }, () => 0);
  for (const e of all) {
    const ts = Date.parse(e.ts);
    if (ts < monthStart || ts > now) continue;
    daily[new Date(ts).getDate() - 1] += e.costUsd;
  }
  let acc = 0;
  const cumulative = daily.slice(0, today).map((v) => (acc += v));
  const spent = acc;
  const projection = today > 0 ? (spent / today) * daysInMonth : 0;

  // --- 3. ranking de agentes por coste
  const ranking = activeSorted
    .map((id) => {
      const ts = turns.filter((t) => t.agentId === id);
      const ttsCost = tts.filter((t) => t.agentId === id).reduce((s, t) => s + t.costUsd, 0);
      return {
        id,
        name: names.get(id) ?? id,
        slot: colored.has(id) ? slotted.indexOf(id) : null,
        costUsd: ts.reduce((s, t) => s + t.costUsd, 0) + ttsCost,
        tokens: ts.reduce((s, t) => s + totalTokens(t), 0),
        turns: ts.length,
        conversations: new Set(ts.map((t) => t.sessionId)).size,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);

  // --- 6. latencia por paso (anatomía de una respuesta)
  const stepSamples: Record<string, number[]> = {};
  for (const t of turns) {
    if (t.route === 'saludo') continue;
    const known = Object.values(t.latencyMs.steps).reduce((s, v) => s + v, 0);
    const steps = { ...t.latencyMs.steps, motor: Math.max(0, t.latencyMs.total - known) };
    for (const [k, v] of Object.entries(steps)) (stepSamples[k] ??= []).push(v);
  }
  if (tts.length) stepSamples.voz = tts.map((t) => t.latencyMs);
  const latency = STEP_ORDER.filter((k) => stepSamples[k]?.length).map((k) => {
    const v = [...stepSamples[k]].sort((a, b) => a - b);
    return { step: k, label: STEP_LABELS[k] ?? k, avgMs: Math.round(v.reduce((s, x) => s + x, 0) / v.length), p95Ms: Math.round(percentile(v, 95)), count: v.length };
  });
  const totals = turns.filter((t) => t.route !== 'saludo').map((t) => t.latencyMs.total).sort((a, b) => a - b);

  // --- 10. coste por resultado (una conversación = un punto)
  const sessions = new Map<string, TurnEvent[]>();
  for (const t of turns) if (t.sessionId !== 'error') (sessions.get(t.sessionId) ?? sessions.set(t.sessionId, []).get(t.sessionId)!).push(t);
  // Mismo color que en el resto del panel; solo los slots 1–3 (validados para
  // todos los pares) se pintan en la dispersión, el resto va a "Otros"
  const scatterSlot = (id: string) => {
    const slot = colored.has(id) ? slotted.indexOf(id) : null;
    return slot !== null && slot < SCATTER_SLOTS ? slot : null;
  };
  const scatterAgents = slotted.filter((id) => scatterSlot(id) !== null);
  const conversations = [...sessions.entries()].map(([sessionId, ts]) => {
    const userTurns = ts.filter((t) => t.route !== 'saludo').length;
    const outcome = ts.some((t) => t.topic && ESCALATION.test(t.topic) && !SYSTEM_TOPICS.test(t.topic))
      ? 'Escalado'
      : ts.some((t) => t.route === 'tema' && t.topic && !SYSTEM_TOPICS.test(t.topic))
        ? 'Flujo guiado'
        : userTurns <= 1
          ? 'Abandonada'
          : 'Respuesta libre';
    const agentId = ts[0].agentId;
    return {
      sessionId,
      agentId,
      name: names.get(agentId) ?? agentId,
      slot: scatterSlot(agentId),
      tokens: ts.reduce((s, t) => s + totalTokens(t), 0),
      costUsd: ts.reduce((s, t) => s + t.costUsd, 0),
      turns: userTurns,
      outcome,
      started: ts[0].ts,
    };
  });

  return {
    range,
    demo,
    generatedAt: new Date(now).toISOString(),
    defaultModel: defaultModelSpec(),
    byModel,
    kpis: {
      tokens: turns.reduce((s, t) => s + totalTokens(t), 0),
      costUsd: turns.reduce((s, t) => s + t.costUsd, 0) + tts.reduce((s, t) => s + t.costUsd, 0) + llmCalls.reduce((s, t) => s + t.costUsd, 0),
      conversations: sessions.size,
      turns: turns.length,
      p50LatencyMs: Math.round(percentile(totals, 50)),
      p95LatencyMs: Math.round(percentile(totals, 95)),
      unknownTokenTurns: turns.filter((t) => !t.tokens.known).length,
      errors: turns.filter((t) => t.error).length,
    },
    agents,
    tokensSeries: { hourly, buckets: buckets.map((b) => new Date(b).toISOString()), series },
    costMonth: { month: new Date(monthStart).toISOString(), daysInMonth, today, cumulative, spent, projection, budget: PRICES.monthlyBudget },
    ranking,
    latency: { steps: latency, p50: Math.round(percentile(totals, 50)), p95: Math.round(percentile(totals, 95)) },
    conversations: { outcomes: OUTCOMES, scatterAgents: scatterAgents.map((id) => ({ id, name: names.get(id) ?? id, slot: scatterSlot(id) })), points: conversations },
  };
}

// ---------- datos de ejemplo (30 días) ----------

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function makeDemo(agentIds: string[]): MetricEvent[] {
  const demoModel = parseModel(defaultModelSpec());
  const demoPrice = priceOf(demoModel);
  const r = rng(42);
  const between = (a: number, b: number) => Math.round(a + r() * (b - a));
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const ids = [...new Set([...agentIds, 'soporte-cliente', 'helpdesk-ti', 'citas-salud'])].slice(0, 4);
  const weight = [1, 0.7, 0.45, 0.25];
  const topicsBy: Record<string, string[]> = {
    'soporte-cliente': ['Abrir caso', 'Hablar con una persona'],
    'helpdesk-ti': ['Restablecer contraseña'],
    'citas-salud': ['Agendar cita'],
  };
  const events: MetricEvent[] = [];
  const now = Date.now();
  for (let day = 29; day >= 0; day--) {
    for (const [i, agentId] of ids.entries()) {
      const convs = Math.round(between(4, 16) * weight[i] * (1 + (29 - day) / 40));
      for (let c = 0; c < convs; c++) {
        const sessionId = `demo-${agentId}-${day}-${c}`;
        let ts = now - day * 864e5 - between(0, 23 * 36e5);
        if (ts > now) ts = now - between(60e3, 36e5);
        const push = (e: Omit<TurnEvent, 'type' | 'ts' | 'agentId' | 'sessionId' | 'channel' | 'costUsd'>) => {
          ts += between(15e3, 90e3);
          const costUsd = costOf(demoPrice, e.tokens.input, e.tokens.cacheHit, e.tokens.output);
          const models = e.tokens.input ? { [demoModel.ref]: { calls: 1, input: e.tokens.input, cacheHit: e.tokens.cacheHit, output: e.tokens.output, costUsd } } : undefined;
          events.push({ type: 'turn', ts: new Date(Math.min(ts, now)).toISOString(), agentId, sessionId, channel: pick(['ui', 'api', 'api', 'openai', 'mcp'] as const), costUsd, ...(models ? { models } : {}), ...e });
        };
        push({ route: 'saludo', topic: 'Saludo', tokens: { input: 0, cacheHit: 0, output: 0, known: true }, latencyMs: { total: between(3, 15), steps: {} } });
        const kind = r();
        // < 0.12: abandonada tras un mensaje · 0.12–0.5: flujo guiado · resto: respuesta libre
        const nTurns = kind < 0.12 ? 1 : between(2, 7);
        const topics = topicsBy[agentId] ?? ['Agendar demo'];
        const guided = kind >= 0.12 && kind < 0.5;
        for (let t = 0; t < nTurns; t++) {
          if (guided && t < 3) {
            const classify = r() < 0.5;
            const input = classify ? between(250, 600) : 0;
            const steps: Record<string, number> = classify ? { clasificar: between(300, 900) } : {};
            const topic = kind < 0.17 && topicsBy[agentId]?.includes('Hablar con una persona') ? 'Hablar con una persona' : topics[0];
            push({ route: 'tema', topic, tokens: { input, cacheHit: Math.round(input * r() * 0.5), output: classify ? 6 : 0, known: true }, latencyMs: { total: Object.values(steps).reduce((s, v) => s + v, 0) + between(5, 30), steps } });
          } else {
            const input = between(900, 3200) + t * between(150, 400);
            const output = between(70, 420);
            const steps: Record<string, number> = { conocimiento: between(4, 45), llm: between(900, 4200) };
            if (r() < 0.12) steps.accion = between(200, 1600);
            push({ route: 'generativa', tokens: { input, cacheHit: Math.round(input * r() * 0.6), output, known: true }, latencyMs: { total: Object.values(steps).reduce((s, v) => s + v, 0) + between(10, 60), steps } });
            if (r() < 0.3) {
              const chars = between(80, 420);
              events.push({ type: 'tts', ts: new Date(Math.min(ts + 500, now)).toISOString(), agentId, chars, latencyMs: between(400, 1500), costUsd: (chars / 1000) * PRICES.ttsPer1kChars });
            }
          }
        }
      }
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}
