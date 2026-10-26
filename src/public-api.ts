// API pública para conectar Agent Studio con otras apps:
//   /v1/...                 REST (documentada en /v1/openapi.json)
//   /v1/chat/completions    compatible con OpenAI (model = id del agente)
//   /mcp                    servidor MCP por HTTP (Streamable HTTP)
// Todo requiere una clave de API salvo /v1/openapi.json. La clave es de una empresa
// y solo da los permisos de sus scopes (se comprueban con can() en cada ruta).
// CORS abierto para apps web.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { listAgents, getAgent, saveAgent, uniqueId, ROOT } from './store.ts';
import { handleTurn, resetSession } from './engine.ts';
import { textToSpeech } from './voice.ts';
import { recordTts, readEvents } from './metrics.ts';
import { aggregate } from './metrics-report.ts';
import { verifyApiKey } from './tenancy/apikeys.ts';
import { contextForApiKey, type Ctx } from './authz/context.ts';
import { can } from './authz/can.ts';
import { ipOf } from './http.ts';
import { createMcpServer } from './mcp.ts';
import { openapi } from './openapi.ts';
import type { AgentDef } from './types.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, X-Api-Key, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, ...CORS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5 * 1024 * 1024) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 });
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

const publicAgent = (a: AgentDef) => ({
  id: a.id,
  name: a.name,
  description: a.description ?? null,
  icon: a.icon ?? null,
  category: a.category ?? {},
  language: a.language ?? 'español',
  greeting: a.greeting ?? null,
  topics: (a.topics ?? []).map((t) => ({ name: t.name, triggers: t.triggers ?? [] })),
  voice: a.voice ?? null,
});

async function templates(): Promise<AgentDef[]> {
  return (YAML.parse(await readFile(join(ROOT, 'catalog', 'catalog.yaml'), 'utf8')) as { templates: AgentDef[] }).templates;
}

// ---------- MCP por HTTP (sin estado: un servidor por petición) ----------

async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method !== 'POST') {
    // Modo sin sesión: no hay stream GET ni cierre de sesión
    return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Usa POST en /mcp' }, id: null });
  }
  const body = await readJson<unknown>(req);
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---------- compatible con OpenAI ----------

interface OpenAiMessage {
  role: string;
  content: string | { type: string; text?: string }[];
}

function contentText(c: OpenAiMessage['content']): string {
  return typeof c === 'string' ? c : c.map((p) => p.text ?? '').join('');
}

async function chatCompletions(req: IncomingMessage, res: ServerResponse, tenantId: number): Promise<void> {
  const body = await readJson<{ model?: string; messages?: OpenAiMessage[]; stream?: boolean; user?: string }>(req);
  if (!body.model) return send(res, 400, { error: { message: 'Falta "model" (id del agente; ver GET /v1/models)' } });
  const agent = await getAgent(tenantId, body.model);
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  // La sesión se mantiene con la cabecera X-Session-Id o el campo "user"
  const sessionId = (req.headers['x-session-id'] as string | undefined) ?? body.user;
  const r = await handleTurn(agent, sessionId, last ? contentText(last.content) : '', 'openai');
  const content = r.messages.join('\n\n') + (r.options?.length ? `\n\nOpciones: ${r.options.join(' · ')}` : '');
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  res.setHeader('X-Session-Id', r.sessionId);

  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS, 'Access-Control-Expose-Headers': 'X-Session-Id' });
    const chunk = (delta: object, finish: string | null) =>
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: agent.id, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content }, null);
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
    return;
  }
  send(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model: agent.id,
    session_id: r.sessionId,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// ---------- enrutado ----------

export async function handlePublic(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith('/v1/') && path !== '/v1' && path !== '/mcp') return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }
  if (path === '/v1/openapi.json') {
    send(res, 200, openapi(`http://${req.headers.host ?? 'localhost:3000'}`));
    return true;
  }
  const key = await verifyApiKey(req);
  if (!key) {
    send(res, 401, { error: 'Falta la clave de API o no es válida (o fue revocada). Usa "Authorization: Bearer <clave>" o "X-Api-Key".' });
    return true;
  }
  const ctx = await contextForApiKey(key, ipOf(req));
  const tenantId = ctx.tenantId;
  // Cada ruta pide un permiso: la clave debe tenerlo en sus scopes
  const allow = async (permission: string, feature?: string) => {
    const d = await can(ctx, { permission, feature });
    if (!d.ok) send(res, d.status, { error: d.message, code: d.code });
    return d.ok;
  };
  if (path === '/mcp') {
    if (await allow('agents.read')) await handleMcp(req, res, ctx);
    return true;
  }

  const m = (re: RegExp) => path.match(re);
  let p: RegExpMatchArray | null;

  if (req.method === 'GET' && path === '/v1/agents') {
    if (!(await allow('agents.read'))) return true;
    send(res, 200, { data: (await listAgents(tenantId)).map(publicAgent) });
  } else if (req.method === 'POST' && path === '/v1/agents') {
    if (!(await allow('agents.manage'))) return true;
    if (ctx.plan.maxAgents !== null && (await listAgents(tenantId)).length >= ctx.plan.maxAgents) return send(res, 403, { error: `Tu plan permite ${ctx.plan.maxAgents} agentes` }), true;
    const b = await readJson<Partial<AgentDef>>(req);
    if (!b.name || !b.instructions) return send(res, 400, { error: 'Se requieren "name" e "instructions"' }), true;
    const agent = await saveAgent(tenantId, { ...b, id: await uniqueId(tenantId, b.name), name: b.name, instructions: b.instructions } as AgentDef);
    send(res, 201, publicAgent(agent));
  } else if (req.method === 'GET' && (p = m(/^\/v1\/agents\/([^/]+)$/))) {
    if (!(await allow('agents.read'))) return true;
    send(res, 200, publicAgent(await getAgent(tenantId, decodeURIComponent(p[1]))));
  } else if (req.method === 'POST' && (p = m(/^\/v1\/agents\/([^/]+)\/chat$/))) {
    if (!(await allow('agents.read'))) return true;
    const b = await readJson<{ message?: string; session_id?: string }>(req);
    const r = await handleTurn(await getAgent(tenantId, decodeURIComponent(p[1])), b.session_id, b.message ?? '', 'api');
    send(res, 200, { session_id: r.sessionId, messages: r.messages, reply: r.messages.join('\n\n'), options: r.options ?? [], topic: r.topic ?? null, sources: r.sources ?? [] });
  } else if (req.method === 'DELETE' && (p = m(/^\/v1\/sessions\/([^/]+)$/))) {
    if (!(await allow('agents.read'))) return true;
    resetSession(tenantId, decodeURIComponent(p[1]));
    res.writeHead(204, CORS);
    res.end();
  } else if (req.method === 'GET' && path === '/v1/templates') {
    if (!(await allow('agents.read'))) return true;
    send(res, 200, { data: (await templates()).map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category })) });
  } else if (req.method === 'POST' && (p = m(/^\/v1\/templates\/([^/]+)\/use$/))) {
    if (!(await allow('agents.manage'))) return true;
    const tpl = (await templates()).find((t) => t.id === decodeURIComponent(p![1]));
    if (!tpl) return send(res, 404, { error: 'Plantilla no encontrada' }), true;
    send(res, 201, publicAgent(await saveAgent(tenantId, { ...structuredClone(tpl), id: await uniqueId(tenantId, tpl.id), source: 'template' })));
  } else if (req.method === 'POST' && path === '/v1/tts') {
    if (!(await allow('agents.read'))) return true;
    const b = await readJson<{ text?: string; agent_id?: string }>(req);
    if (!b.text) return send(res, 400, { error: 'Falta "text"' }), true;
    const agent = b.agent_id ? await getAgent(tenantId, b.agent_id) : undefined;
    const t0 = performance.now();
    const audio = await textToSpeech(b.text, agent?.voice?.voiceId, agent?.voice?.model);
    void recordTts(tenantId, agent?.id, b.text.length, performance.now() - t0);
    send(res, 200, audio, 'audio/mpeg');
  } else if (req.method === 'POST' && (p = m(/^\/v1\/flows\/([^/]+)\/run$/))) {
    if (!(await allow('flows.manage'))) return true;
    const { getFlow, runFlow } = await import('./flows.ts');
    const b = await readJson<{ payload?: unknown }>(req);
    send(res, 200, await runFlow(await getFlow(tenantId, decodeURIComponent(p[1])), b.payload ?? {}, 'api'));
  } else if (req.method === 'GET' && path === '/v1/metrics') {
    if (!(await allow('metrics.read'))) return true;
    const q = new URL(req.url ?? '', 'http://x').searchParams.get('range');
    const { events, demo } = await readEvents(tenantId);
    send(res, 200, aggregate(events, await listAgents(tenantId), q === '24h' || q === '30d' ? q : '7d', demo));
  } else if (req.method === 'GET' && path === '/v1/models') {
    if (!(await allow('agents.read'))) return true;
    send(res, 200, { object: 'list', data: (await listAgents(tenantId)).map((a) => ({ id: a.id, object: 'model', created: 0, owned_by: 'agent-studio' })) });
  } else if (req.method === 'POST' && path === '/v1/chat/completions') {
    if (!(await allow('agents.read'))) return true;
    await chatCompletions(req, res, tenantId);
  } else {
    send(res, 404, { error: 'Ruta no encontrada. Ver /v1/openapi.json' });
  }
  return true;
}
