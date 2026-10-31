// Backend Claude Code: con AGENT_BACKEND=claude-code las respuestas generativas
// de los agentes las da Claude Code, usado como librería con el Claude Agent SDK
// (@anthropic-ai/claude-agent-sdk). Sustituye al antiguo backend NanoClaw.
//
// - Cada agente tiene su espacio de trabajo por empresa:
//     data/tenants/<empresa>/claude-code/<agente>/CLAUDE.md
//   con las instrucciones, temas, conocimiento y acciones, generado a partir del
//   YAML del agente (edítalo en Agent Studio: se regenera en cada turno si cambió).
// - Cada conversación de Agent Studio continúa su sesión de Claude Code (resume).
// - Herramientas: las acciones HTTP del agente y las herramientas de los módulos
//   de negocio activos van en un servidor MCP en proceso, con las mismas reglas
//   que el backend directo (can(), auditoría). Las herramientas integradas de
//   Claude Code (Bash, Read, Write...) están desactivadas: el agente atiende a
//   clientes, no programa en el servidor. CLAUDE_CODE_TOOLS permite algunas
//   (p. ej. WebSearch), solo en la empresa Default.
// - Uso y coste: los que informa Claude Code se apuntan en las métricas del turno.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query as sdkQuery, createSdkMcpServer, tool, type McpServerConfig, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentDef, Session, Step } from './types.ts';
import { agentDir } from './store.ts';
import { DEFAULT_TENANT_ID, resolveInside, tenantDataPath } from './tenancy/paths.ts';
import { actionTools, runAction, toolName } from './actions.ts';
import { featureToolsFor, runFeatureTool } from './features/enforce.ts';
import { addUsage } from './metrics.ts';

const configured = (process.env.AGENT_BACKEND ?? 'direct').toLowerCase();
if (configured === 'nanoclaw') console.warn('⚠ AGENT_BACKEND=nanoclaw ya no existe: se usa Claude Code (AGENT_BACKEND=claude-code).');
export const BACKEND = configured === 'nanoclaw' ? 'claude-code' : configured; // direct | claude-code

export const MODEL = process.env.CLAUDE_CODE_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_CODE_EFFORT as Options['effort'] | undefined;
const MAX_TURNS = Number(process.env.CLAUDE_CODE_MAX_TURNS ?? 10);
const REPLY_TIMEOUT_MS = Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 180_000);
// Herramientas integradas de Claude Code permitidas (solo en la empresa Default)
const BUILTIN_TOOLS = (process.env.CLAUDE_CODE_TOOLS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const SERVER = 'agent-studio';

export function useClaudeCode(): boolean {
  return BACKEND === 'claude-code';
}

// Credenciales: las resuelve Claude Code (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
// un login de `claude`/`ant` o Bedrock/Vertex por sus variables)
export function status() {
  return {
    model: MODEL,
    // Solo orientativo: Claude Code también puede usar su propio login o un proxy
    apiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX || existsSync(join(homedir(), '.claude', '.credentials.json'))),
    builtinTools: BUILTIN_TOOLS,
  };
}

// Las pruebas sustituyen query() para no llamar a la API
let queryImpl: typeof sdkQuery = sdkQuery;
export function setQueryImpl(fn: typeof sdkQuery | null): void {
  queryImpl = fn ?? sdkQuery;
}

export function workspaceDir(agent: AgentDef): string {
  return tenantDataPath(agent.tenantId!, 'claude-code', agent.id);
}

// ---------- CLAUDE.md a partir del agente ----------

function stepsToMarkdown(steps: Step[], depth = 0): string {
  const pad = '  '.repeat(depth);
  return steps
    .map((s) => {
      switch (s.type) {
        case 'message': return `${pad}- Di: "${s.text}"`;
        case 'question': return `${pad}- Pregunta: "${s.prompt}" (guarda la respuesta como \`${s.variable}\`${s.options?.length ? `; opciones: ${s.options.join(', ')}` : ''})`;
        case 'condition': return `${pad}- Si \`${s.if}\`:\n${stepsToMarkdown(s.then, depth + 1)}${s.else?.length ? `\n${pad}- Si no:\n${stepsToMarkdown(s.else, depth + 1)}` : ''}`;
        case 'set': return `${pad}- Asigna \`${s.variable}\` = ${s.value}`;
        case 'action': return `${pad}- Usa la herramienta **${toolName(s.action)}**${s.saveAs ? ` y recuerda el resultado como \`${s.saveAs}\`` : ''}`;
        case 'generate': return `${pad}- Responde con tus propias palabras${s.prompt ? `: ${s.prompt}` : ''} usando el conocimiento`;
        case 'goto': return `${pad}- Continúa con el tema **${s.topic}**`;
        case 'end': return `${pad}- Termina el tema`;
      }
    })
    .join('\n');
}

async function knowledgeMarkdown(agent: AgentDef): Promise<string> {
  const parts: string[] = [];
  for (const k of agent.knowledge ?? []) {
    if (k.type === 'text' && k.content) parts.push(`### ${k.name ?? 'Texto'}\n\n${k.content.trim()}`);
    if (k.type === 'url' && k.url) parts.push(`### ${k.name ?? k.url}\n\nFuente: ${k.url}`);
    if (k.type === 'file' && k.path) {
      try {
        const text = await readFile(resolveInside(agentDir(agent.tenantId!, agent.id), k.path), 'utf8');
        parts.push(`### ${k.name ?? k.path}\n\n${text.slice(0, 30_000).trim()}`);
      } catch {}
    }
  }
  return parts.join('\n\n');
}

export async function buildClaudeMd(agent: AgentDef): Promise<string> {
  const sections = [
    `<!-- Generado por Agent Studio a partir de agents/${agent.tenantId}/${agent.id}/agent.yaml. Edítalo allí: se sobrescribe. -->`,
    `# ${agent.name}`,
    agent.description ? `> ${agent.description}` : '',
    `## Instrucciones\n\n${agent.instructions.trim()}`,
    `Responde siempre en ${agent.language ?? 'español'}, de forma breve y clara.`,
  ];
  if (agent.greeting) sections.push(`## Saludo\n\nAl empezar una conversación nueva, saluda con: "${agent.greeting}"`);
  if (agent.topics?.length) {
    sections.push(
      `## Temas (flujos guiados)\n\nCuando el mensaje del usuario encaje con uno de estos temas, sigue sus pasos en orden, haciendo una pregunta cada vez.\n\n` +
        agent.topics
          .map((t) => `### ${t.name}\n${t.description ? `${t.description}\n` : ''}${t.triggers?.length ? `Frases típicas: ${t.triggers.slice(0, 8).map((x) => `"${x}"`).join(', ')}\n` : ''}\n${stepsToMarkdown(t.steps)}`)
          .join('\n\n'),
    );
  }
  const knowledge = await knowledgeMarkdown(agent);
  if (knowledge) sections.push(`## Conocimiento\n\nUsa esta información para responder. Si algo no está aquí, dilo en vez de inventarlo.\n\n${knowledge}`);
  if (agent.actions?.length) {
    sections.push(`## Acciones disponibles\n\nSon herramientas del servidor MCP «${SERVER}»:\n\n${agent.actions.map((a) => `- **${toolName(a.name)}**: ${a.description}`).join('\n')}`);
  }
  return sections.filter(Boolean).join('\n\n') + '\n';
}

// Escribe CLAUDE.md en el espacio del agente (solo si cambió)
export async function syncAgent(agent: AgentDef): Promise<{ workspace: string; syncedAt: string; changed: boolean }> {
  const dir = workspaceDir(agent);
  const file = resolveInside(dir, 'CLAUDE.md');
  const content = await buildClaudeMd(agent);
  let current = '';
  try { current = await readFile(file, 'utf8'); } catch {}
  const changed = current !== content;
  if (changed) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  return { workspace: dir, syncedAt: new Date().toISOString(), changed };
}

// ---------- herramientas (servidor MCP en proceso) ----------

// JSON Schema de una acción → forma de Zod que pide el SDK
function shapeOf(schema: object): Record<string, z.ZodType> {
  try {
    const s = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    if (s instanceof z.ZodObject) return s.shape as Record<string, z.ZodType>;
  } catch {}
  return {};
}

const asText = (out: string) => ({ content: [{ type: 'text' as const, text: out.slice(0, 12_000) }] });

async function toolServer(agent: AgentDef, session: Session) {
  const tenantId = agent.tenantId!;
  const defs = [];
  for (const spec of actionTools(agent.actions)) {
    const action = agent.actions!.find((a) => toolName(a.name) === spec.function.name)!;
    defs.push(tool(spec.function.name, spec.function.description || spec.function.name, shapeOf(spec.function.parameters), async (args) => asText(await runAction(action, args as Record<string, unknown>, tenantId))));
  }
  // Solo las de módulos activos y configurados; al ejecutarse se vuelve a comprobar y auditar
  for (const spec of await featureToolsFor(tenantId)) {
    defs.push(tool(spec.function.name, spec.function.description, shapeOf(spec.function.parameters), async (args) =>
      asText(await runFeatureTool({ tenantId, agentId: agent.id, sessionId: session.id, name: spec.function.name, args: args as Record<string, unknown> }))));
  }
  return { server: createSdkMcpServer({ name: SERVER, version: '0.1.0', tools: defs }), names: defs.map((d) => d.name) };
}

// Servidores MCP del YAML del agente. Por stdio solo en la empresa Default (ejecutan
// programas en el servidor), igual que con el backend directo.
function agentMcpServers(agent: AgentDef): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of agent.mcpServers ?? []) {
    const name = s.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    if (!name || name === SERVER) continue;
    const transport = s.transport ?? (s.command ? 'stdio' : 'http');
    if (transport === 'stdio') {
      if (agent.tenantId !== DEFAULT_TENANT_ID && process.env.MCP_STDIO_ALL_TENANTS !== 'true') continue;
      if (s.command) out[name] = { type: 'stdio', command: s.command, args: s.args ?? [] };
    } else if (s.url) out[name] = { type: transport === 'sse' ? 'sse' : 'http', url: s.url, headers: s.headers ?? {} };
  }
  return out;
}

// ---------- conversar ----------

export interface ClaudeCodeReply { text: string }

export async function send(agent: AgentDef, session: Session, text: string): Promise<ClaudeCodeReply> {
  const sync = await syncAgent(agent);
  const { server, names } = await toolServer(agent, session);
  const external = agentMcpServers(agent);
  const builtin = agent.tenantId === DEFAULT_TENANT_ID ? BUILTIN_TOOLS : [];
  const state = (session.claudeCode ??= { costUsd: 0, tokens: { input: 0, cacheHit: 0, output: 0 } });
  // Si el CLAUDE.md cambió, conversación nueva: así el agente ve sus instrucciones nuevas
  const resume = sync.changed ? undefined : state.sessionId;
  if (!resume) Object.assign(state, { sessionId: undefined, costUsd: 0, tokens: { input: 0, cacheHit: 0, output: 0 } });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REPLY_TIMEOUT_MS);
  const options: Options = {
    cwd: sync.workspace,
    ...(resume ? { resume } : {}),
    model: agent.model?.startsWith('claude') ? agent.model : MODEL,
    ...(EFFORT ? { effort: EFFORT } : {}),
    systemPrompt: `Eres un agente conversacional creado con Agent Studio que atiende a los usuarios de una empresa. Tu definición (instrucciones, temas, conocimiento y acciones) está en CLAUDE.md. Responde solo con el mensaje para el usuario.`,
    settingSources: ['project'], // carga el CLAUDE.md del espacio del agente
    tools: builtin, // [] = ninguna herramienta integrada (Bash, Read, Write…)
    allowedTools: [...builtin, ...names.map((n) => `mcp__${SERVER}__${n}`), ...Object.keys(external).map((n) => `mcp__${n}`)],
    permissionMode: 'dontAsk', // lo que no está en allowedTools se rechaza
    mcpServers: { [SERVER]: server, ...external },
    maxTurns: MAX_TURNS,
    abortController: abort,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-studio/0.1.0' },
  };
  let result: Extract<SDKMessage, { type: 'result' }> | undefined;
  try {
    for await (const msg of queryImpl({ prompt: text, options })) {
      if (msg.type === 'system' && 'session_id' in msg && msg.session_id) state.sessionId = msg.session_id;
      if (msg.type === 'result') result = msg;
    }
  } catch (err) {
    if (abort.signal.aborted) throw new Error('Claude Code no respondió a tiempo');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!result) throw new Error('Claude Code terminó sin respuesta');
  state.sessionId = result.session_id;
  // Coste y tokens llegan acumulados por sesión (también al reanudarla): se apunta la diferencia
  const totals = Object.values(result.modelUsage ?? {}).reduce(
    (a, u) => ({ input: a.input + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, cacheHit: a.cacheHit + u.cacheReadInputTokens, output: a.output + u.outputTokens }),
    { input: 0, cacheHit: 0, output: 0 },
  );
  addUsage(`claude-code:${options.model}`, {
    input: Math.max(0, totals.input - state.tokens.input),
    cacheHit: Math.max(0, totals.cacheHit - state.tokens.cacheHit),
    output: Math.max(0, totals.output - state.tokens.output),
    costUsd: Math.max(0, (result.total_cost_usd ?? 0) - state.costUsd),
  });
  state.costUsd = result.total_cost_usd ?? state.costUsd;
  state.tokens = totals;
  if (result.subtype !== 'success' || result.is_error) {
    throw new Error(`Claude Code no pudo responder (${result.subtype}${result.subtype === 'success' ? `: ${result.result.slice(0, 200)}` : ''})`);
  }
  return { text: result.result };
}
