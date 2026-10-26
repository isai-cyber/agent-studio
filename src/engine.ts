// Motor de conversación. Mismo modelo que Copilot Studio:
//  1. Si el mensaje encaja con un tema (frases disparadoras o clasificación del LLM),
//     se ejecutan sus pasos (mensajes, preguntas, condiciones, acciones...).
//  2. Si no, respuesta generativa con instrucciones + conocimiento + acciones (tools).
import { randomUUID } from 'node:crypto';
import type { AgentDef, ChatMessage, Session, Step, Topic } from './types.ts';
import { chat, llmConfigured } from './llm.ts';
import { search } from './knowledge.ts';
import { actionTools, runAction, toolName } from './actions.ts';
import { agentDir, saveAgent } from './store.ts';
import { useNanoclaw, syncAgent, send as nanoclawSend } from './nanoclaw.ts';
import { runTurn, timed, setRoute, type Channel } from './metrics.ts';
import { bus } from './flows.ts';
import { listTools as mcpListTools, callTool as mcpCallTool } from './mcp-client.ts';
import type { ToolSpec } from './llm.ts';

const sessions = new Map<string, Session>();
const MAX_HISTORY = 30;

export interface TurnResult {
  sessionId: string;
  messages: string[];
  options?: string[];
  topic?: string;
  sources?: string[];
}

export function getSession(agentId: string, sessionId?: string): Session {
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing && existing.agentId === agentId) return existing;
  const s: Session = { id: randomUUID(), agentId, history: [], variables: {} };
  sessions.set(s.id, s);
  return s;
}

export function resetSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ---------- utilidades ----------

function render(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
    const v = k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), vars);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Condiciones simples y seguras: `var == "x"`, `var != 3`, `var > 10`, `var contains "x"`,
// `var` (verdadero si tiene valor), combinables con `and` / `or`. Sin eval.
export function evalCondition(expr: string, vars: Record<string, unknown>): boolean {
  return expr.split(/\s+or\s+/i).some((orPart) =>
    orPart.split(/\s+and\s+/i).every((part) => {
      const m = part.trim().match(/^([\w.]+)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/i);
      const get = (k: string) => k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), vars);
      if (!m) {
        const neg = part.trim().startsWith('!');
        const v = get(part.trim().replace(/^!/, ''));
        const truthy = v !== undefined && v !== null && v !== '' && v !== false;
        return neg ? !truthy : truthy;
      }
      const [, key, op, rawRight] = m;
      const left = get(key);
      const right = rawRight.trim().replace(/^["']|["']$/g, '');
      const ln = Number(left);
      const rn = Number(right);
      const numeric = !Number.isNaN(ln) && !Number.isNaN(rn) && String(left ?? '').trim() !== '';
      const ls = norm(String(left ?? ''));
      const rs = norm(right);
      switch (op.toLowerCase()) {
        case '==': return numeric ? ln === rn : ls === rs;
        case '!=': return numeric ? ln !== rn : ls !== rs;
        case '>': return numeric && ln > rn;
        case '<': return numeric && ln < rn;
        case '>=': return numeric && ln >= rn;
        case '<=': return numeric && ln <= rn;
        case 'contains': return ls.includes(rs);
      }
      return false;
    }),
  );
}

function matchByTrigger(topics: Topic[], text: string): Topic | undefined {
  const t = norm(text);
  if (!t) return undefined;
  let best: { topic: Topic; score: number } | undefined;
  for (const topic of topics) {
    for (const trig of topic.triggers ?? []) {
      const n = norm(trig);
      if (!n) continue;
      if (t === n) return topic;
      const words = n.split(' ').filter((w) => w.length > 2);
      if (!words.length) continue;
      const hits = words.filter((w) => t.includes(w)).length / words.length;
      if (hits >= 0.75 && (!best || hits > best.score)) best = { topic, score: hits };
    }
  }
  return best?.topic;
}

async function matchByLlm(agent: AgentDef, topics: Topic[], text: string, history: ChatMessage[]): Promise<Topic | undefined> {
  // Sin clave directa de DeepSeek (p. ej. todo pasa por NanoClaw) solo se usan las frases disparadoras
  if (!topics.length || !llmConfigured()) return undefined;
  const list = topics
    .map((t, i) => `${i + 1}. ${t.name}: ${t.description ?? ''} Ejemplos: ${(t.triggers ?? []).slice(0, 6).join(' | ')}`)
    .join('\n');
  const recent = history.slice(-4).map((m) => `${m.role}: ${m.content ?? ''}`).join('\n');
  const res = await chat(
    [
      {
        role: 'system',
        content:
          'Eres un clasificador de intenciones. Devuelve JSON {"topic": número} con el tema que mejor encaja con el ÚLTIMO mensaje del usuario, o {"topic": 0} si ninguno encaja claramente. Solo JSON.',
      },
      { role: 'user', content: `Temas:\n${list}\n\nConversación reciente:\n${recent}\n\nÚltimo mensaje: ${text}` },
    ],
    { model: agent.model, temperature: 0, json: true, step: 'clasificar' },
  );
  try {
    const n = Number(JSON.parse(res.content ?? '{}').topic);
    return n > 0 ? topics[n - 1] : undefined;
  } catch {
    return undefined;
  }
}

function matchOption(options: string[], answer: string): string | undefined {
  const a = norm(answer);
  const idx = Number(a);
  if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) return options[idx - 1];
  return options.find((o) => norm(o) === a) ?? options.find((o) => a.includes(norm(o)) || norm(o).includes(a));
}

// ---------- respuesta generativa ----------

// Con AGENT_BACKEND=nanoclaw la respuesta la genera el agente en NanoClaw
// (opencode → DeepSeek), que guarda su propio historial y conocimiento (CLAUDE.md).
export async function ensureNanoclaw(agent: AgentDef): Promise<NonNullable<AgentDef['nanoclaw']>> {
  if (agent.nanoclaw?.conversationId) return agent.nanoclaw;
  agent.nanoclaw = await syncAgent(agent);
  await saveAgent(agent);
  return agent.nanoclaw;
}

async function generate(agent: AgentDef, session: Session, userText: string, extraPrompt?: string, useKnowledge = true): Promise<{ text: string; sources: string[]; options?: string[] }> {
  if (useNanoclaw()) {
    const link = await ensureNanoclaw(agent);
    const prompt = extraPrompt ? `${userText}\n\n[Contexto del flujo: ${render(extraPrompt, session.variables)}]` : userText;
    setRoute('nanoclaw');
    const reply = await timed('nanoclaw', () => nanoclawSend(link.conversationId, prompt));
    return { text: reply.text, sources: ['NanoClaw'], options: reply.options };
  }
  const dir = agentDir(agent.id);
  setRoute('generativa');
  const hits = useKnowledge ? await timed('conocimiento', () => search(agent, dir, userText)) : [];
  const knowledge = hits.length
    ? `\n\n# Conocimiento relevante (cita la fuente si lo usas)\n${hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.text}`).join('\n\n')}`
    : agent.knowledge?.length
      ? '\n\n# Conocimiento\nNo se encontró información relevante en la base de conocimiento. Si no sabes la respuesta, dilo.'
      : '';
  const vars = Object.keys(session.variables).length ? `\n\n# Datos de la conversación\n${JSON.stringify(session.variables)}` : '';
  const system: ChatMessage = {
    role: 'system',
    content: `${agent.instructions}${extraPrompt ? `\n\n# Tarea actual\n${render(extraPrompt, session.variables)}` : ''}${knowledge}${vars}\n\nResponde en ${agent.language ?? 'español'}. Sé conciso.`,
  };
  // Herramientas: acciones HTTP del agente + herramientas de sus servidores MCP
  const mcp = new Map<string, { server: NonNullable<AgentDef['mcpServers']>[number]; tool: string }>();
  const mcpSpecs: ToolSpec[] = [];
  for (const server of agent.mcpServers ?? []) {
    try {
      for (const t of await timed('mcp', () => mcpListTools(server))) {
        const name = `mcp_${server.name}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        mcp.set(name, { server, tool: t.name });
        mcpSpecs.push({ type: 'function', function: { name, description: `[${server.name}] ${t.description ?? t.name}`.slice(0, 1000), parameters: t.inputSchema ?? { type: 'object', properties: {} } } });
      }
    } catch (err) {
      console.warn(`[mcp] ${server.name}:`, (err as Error).message);
    }
  }
  const tools = [...actionTools(agent.actions), ...mcpSpecs];
  const messages: ChatMessage[] = [system, ...session.history.slice(-MAX_HISTORY)];

  for (let i = 0; i < 5; i++) {
    const res = await chat(messages, { model: agent.model, temperature: agent.temperature, tools });
    if (!res.tool_calls?.length) {
      return { text: res.content ?? '', sources: [...new Set(hits.map((h) => h.source))] };
    }
    messages.push({ role: 'assistant', content: res.content, tool_calls: res.tool_calls });
    for (const call of res.tool_calls) {
      const action = agent.actions?.find((a) => toolName(a.name) === call.function.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {}
      const viaMcp = mcp.get(call.function.name);
      const out = viaMcp
        ? await timed('mcp', async () => {
            try {
              const r = await mcpCallTool(viaMcp.server, viaMcp.tool, args);
              return JSON.stringify({ isError: r.isError, text: r.text.slice(0, 12000), structured: r.structured });
            } catch (err) {
              return JSON.stringify({ error: (err as Error).message });
            }
          })
        : action ? await timed('accion', () => runAction(action, args)) : JSON.stringify({ error: 'acción desconocida' });
      messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  return { text: 'No pude completar la solicitud.', sources: [] };
}

// ---------- ejecución de temas ----------

async function runSteps(agent: AgentDef, session: Session, topicName: string, stack: Step[][], userText: string, out: TurnResult): Promise<void> {
  let guard = 0;
  while (stack.length) {
    if (++guard > 200) throw new Error('Demasiados pasos (¿bucle en el tema?)');
    const frame = stack[stack.length - 1];
    const step = frame.shift();
    if (!step) {
      stack.pop();
      continue;
    }
    switch (step.type) {
      case 'message':
        out.messages.push(render(step.text, session.variables));
        break;
      case 'question': {
        out.messages.push(render(step.prompt, session.variables));
        if (step.options?.length) out.options = step.options;
        session.pending = { topic: topicName, stack, waitingFor: { variable: step.variable, options: step.options } };
        return;
      }
      case 'set':
        session.variables[step.variable] = render(step.value, session.variables);
        break;
      case 'condition':
        stack.push([...(evalCondition(step.if, session.variables) ? step.then : (step.else ?? []))]);
        break;
      case 'action': {
        const action = agent.actions?.find((a) => a.name === step.action);
        const args = Object.fromEntries(Object.entries(step.inputs ?? {}).map(([k, v]) => [k, render(v, session.variables)]));
        const raw = action ? await timed('accion', () => runAction(action, args)) : JSON.stringify({ error: `Acción "${step.action}" no definida` });
        if (step.saveAs) {
          try {
            const parsed = JSON.parse(raw);
            try {
              parsed.body = JSON.parse(parsed.body);
            } catch {}
            session.variables[step.saveAs] = parsed;
          } catch {
            session.variables[step.saveAs] = raw;
          }
        }
        break;
      }
      case 'generate': {
        const g = await generate(agent, session, userText, step.prompt, step.useKnowledge ?? true);
        out.messages.push(g.text);
        out.sources = g.sources;
        break;
      }
      case 'goto': {
        const target = agent.topics?.find((t) => t.name === step.topic);
        if (target) {
          topicName = target.name;
          stack.length = 0;
          stack.push(structuredClone(target.steps));
        }
        break;
      }
      case 'end':
        stack.length = 0;
        break;
    }
  }
  session.pending = undefined;
}

// ---------- turno ----------

// Cada turno se mide y registra en las métricas (tokens, coste, latencia, ruta)
export async function handleTurn(agent: AgentDef, sessionId: string | undefined, userText: string, channel: Channel = 'ui'): Promise<TurnResult> {
  const r = await runTurn({ agentId: agent.id, channel }, () => turn(agent, sessionId, userText));
  // Aviso para las automatizaciones con el disparador "Un agente responde"
  bus.emit('agent.turn', { agentId: agent.id, agentName: agent.name, sessionId: r.sessionId, channel, message: userText, reply: r.messages.join('\n\n'), topic: r.topic ?? null, options: r.options ?? [] });
  return r;
}

async function turn(agent: AgentDef, sessionId: string | undefined, userText: string): Promise<TurnResult> {
  const session = getSession(agent.id, sessionId);
  session.variables.botName ??= agent.name;
  const out: TurnResult = { sessionId: session.id, messages: [] };
  const text = userText.trim();

  // Inicio de conversación
  if (!text) {
    setRoute('saludo');
    const start = agent.topics?.find((t) => /saludo|greeting|inicio|conversation start/i.test(t.name));
    if (start) {
      out.topic = start.name;
      await runSteps(agent, session, start.name, [structuredClone(start.steps)], '', out);
    } else if (agent.greeting) {
      out.messages.push(agent.greeting);
    }
    for (const m of out.messages) session.history.push({ role: 'assistant', content: m });
    return out;
  }

  session.history.push({ role: 'user', content: text });

  if (session.pending?.waitingFor) {
    // Respuesta a una pregunta del tema activo
    const { variable, options } = session.pending.waitingFor;
    if (options?.length) {
      const chosen = matchOption(options, text);
      if (!chosen) {
        setRoute('tema');
        out.messages.push(`Elige una opción: ${options.join(', ')}`);
        out.options = options;
        session.history.push({ role: 'assistant', content: out.messages[0] });
        return out;
      }
      session.variables[variable] = chosen;
    } else {
      session.variables[variable] = text;
    }
    setRoute('tema');
    out.topic = session.pending.topic;
    const stack = session.pending.stack;
    session.pending = undefined;
    await runSteps(agent, session, out.topic, stack, text, out);
  } else {
    const topics = agent.topics ?? [];
    const topic = matchByTrigger(topics, text) ?? (await matchByLlm(agent, topics, text, session.history));
    if (topic) {
      setRoute('tema');
      out.topic = topic.name;
      await runSteps(agent, session, topic.name, [structuredClone(topic.steps)], text, out);
    } else {
      const g = await generate(agent, session, text);
      out.messages.push(g.text);
      out.sources = g.sources;
      if (g.options?.length) out.options = g.options;
    }
  }

  for (const m of out.messages) session.history.push({ role: 'assistant', content: m });
  if (session.history.length > MAX_HISTORY * 2) session.history.splice(0, session.history.length - MAX_HISTORY * 2);
  return out;
}
