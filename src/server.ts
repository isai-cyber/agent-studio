// Servidor HTTP: API REST + interfaz web. Sin frameworks, solo node:http.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import YAML from 'yaml';
import { ROOT, listAgents, getAgent, saveAgent, saveAgentYaml, deleteAgent, uniqueId } from './store.ts';
import { handleTurn, resetSession } from './engine.ts';
import { useNanoclaw, BACKEND, status as nanoclawStatus, syncAgent } from './nanoclaw.ts';
import { textToSpeech, speechToText, listVoices, voiceConfigured } from './voice.ts';
import { llmConfigured, DEFAULT_MODEL } from './llm.ts';
import { importPath, importTopicYaml } from './importer.ts';
import type { AgentDef } from './types.ts';
import { handlePublic } from './public-api.ts';
import { authEnabled, initAuth, currentUser, register, login, logout, authInfo, sameOrigin } from './auth.ts';
import { loadModules, listModules, installFromUrl, uninstall, loadErrors, getTrigger } from './modules/registry.ts';
import { listFlows, getFlow, saveFlow, deleteFlow, runFlow, listRuns, startScheduler } from './flows.ts';
import { setConnection, deleteConnection, listMasked } from './connections.ts';
import { planFromText, assistantTurn } from './assistant.ts';
import { recordTts } from './metrics.ts';
import { aggregate, makeDemo } from './metrics-report.ts';
import { clearDemo, writeDemo, readEvents } from './metrics.ts';
import { getApiKey, rotateApiKey } from './apikey.ts';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = join(ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

async function readBody(req: IncomingMessage, limit = 50 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const raw = (await readBody(req)).toString('utf8');
  return (raw ? JSON.parse(raw) : {}) as T;
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// JSON grande (la lista de módulos son varios MB): se comprime si el navegador acepta gzip
function sendBig(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const raw = Buffer.from(JSON.stringify(body));
  if (raw.length < 50_000 || !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return send(res, status, raw);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  res.end(gzipSync(raw));
}

async function loadCatalog(): Promise<{ functions: string[]; industries: string[]; templates: AgentDef[] }> {
  return YAML.parse(await readFile(join(ROOT, 'catalog', 'catalog.yaml'), 'utf8'));
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), h]);

route('GET', '/api/status', async (_req, res) => {
  send(res, 200, {
    backend: BACKEND,
    llm: llmConfigured(),
    model: DEFAULT_MODEL,
    voice: voiceConfigured(),
    ...(useNanoclaw() ? { nanoclaw: await nanoclawStatus() } : {}),
  });
});

route('GET', '/api/catalog', async (_req, res) => send(res, 200, await loadCatalog()));

route('POST', '/api/catalog/:id/use', async (_req, res, [id]) => {
  const tpl = (await loadCatalog()).templates.find((t) => t.id === id);
  if (!tpl) return send(res, 404, { error: 'Plantilla no encontrada' });
  const agent = await saveAgent({ ...structuredClone(tpl), id: await uniqueId(tpl.id), source: 'template' });
  send(res, 201, agent);
});

route('GET', '/api/agents', async (_req, res) => send(res, 200, await listAgents()));

route('POST', '/api/agents', async (req, res) => {
  const body = await json<Partial<AgentDef>>(req);
  const agent = await saveAgent({
    name: body.name ?? 'Nuevo agente',
    instructions: body.instructions ?? 'Eres un asistente útil.',
    ...body,
    id: await uniqueId(body.name ?? 'nuevo-agente'),
  } as AgentDef);
  send(res, 201, agent);
});

route('GET', '/api/agents/:id', async (_req, res, [id]) => send(res, 200, await getAgent(id)));

route('GET', '/api/agents/:id/yaml', async (_req, res, [id]) => {
  const a = await getAgent(id);
  const { id: _omit, ...rest } = a;
  send(res, 200, YAML.stringify(rest, { lineWidth: 0 }), 'text/yaml; charset=utf-8');
});

route('PUT', '/api/agents/:id/yaml', async (req, res, [id]) => {
  const agent = await saveAgentYaml(id, (await readBody(req)).toString('utf8'));
  // Mantener CLAUDE.md de NanoClaw al día si el agente ya está enlazado
  if (useNanoclaw() && agent.nanoclaw) {
    agent.nanoclaw = await syncAgent(agent);
    await saveAgent(agent);
  }
  send(res, 200, agent);
});

route('POST', '/api/agents/:id/nanoclaw/sync', async (_req, res, [id]) => {
  const agent = await getAgent(id);
  agent.nanoclaw = await syncAgent(agent);
  await saveAgent(agent);
  send(res, 200, agent.nanoclaw);
});

route('DELETE', '/api/agents/:id', async (_req, res, [id]) => {
  await deleteAgent(id);
  send(res, 204, '');
});

route('POST', '/api/agents/:id/chat', async (req, res, [id]) => {
  const { message = '', sessionId } = await json<{ message?: string; sessionId?: string }>(req);
  send(res, 200, await handleTurn(await getAgent(id), sessionId, message));
});

route('POST', '/api/sessions/:sid/reset', async (_req, res, [sid]) => {
  resetSession(sid);
  send(res, 204, '');
});

route('POST', '/api/tts', async (req, res) => {
  const { text, agentId } = await json<{ text: string; agentId?: string }>(req);
  const agent = agentId ? await getAgent(agentId) : undefined;
  const t0 = performance.now();
  const audio = await textToSpeech(text, agent?.voice?.voiceId, agent?.voice?.model);
  void recordTts(agent?.id, text.length, performance.now() - t0);
  send(res, 200, audio, 'audio/mpeg');
});

route('POST', '/api/stt', async (req, res) => {
  const audio = await readBody(req);
  const lang = new URL(req.url ?? '', 'http://x').searchParams.get('lang') ?? undefined;
  send(res, 200, { text: await speechToText(audio, req.headers['content-type'] ?? 'audio/webm', lang) });
});

route('GET', '/api/voices', async (_req, res) => send(res, 200, await listVoices()));

// Subida de la solución exportada de Copilot Studio (.zip) en el cuerpo
route('POST', '/api/import/solution', async (req, res) => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-upload-'));
  try {
    const file = join(dir, 'solution.zip');
    await writeFile(file, await readBody(req, 200 * 1024 * 1024));
    send(res, 200, await importPath(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Métricas (panel)
route('GET', '/api/metrics', async (req, res) => {
  const q = new URL(req.url ?? '', 'http://x').searchParams.get('range');
  const range = q === '24h' || q === '30d' ? q : '7d';
  const { events, demo } = await readEvents();
  // Las plantillas aportan nombres legibles a los agentes de los datos de ejemplo
  send(res, 200, aggregate(events, [...(await listAgents()), ...(await loadCatalog()).templates], range, demo));
});
route('POST', '/api/metrics/demo', async (_req, res) => {
  await writeDemo(makeDemo((await listAgents()).map((a) => a.id)));
  send(res, 201, { ok: true });
});
route('DELETE', '/api/metrics/demo', async (_req, res) => {
  await clearDemo();
  send(res, 204, '');
});

// ---------- módulos ----------
route('GET', '/api/modules', async (req, res) => sendBig(req, res, 200, { modules: listModules(), errors: loadErrors }));
route('POST', '/api/modules/reload', async (req, res) => {
  await loadModules();
  sendBig(req, res, 200, { modules: listModules(), errors: loadErrors });
});
route('POST', '/api/modules/install', async (req, res) => {
  const { url } = await json<{ url?: string }>(req);
  send(res, 201, await installFromUrl(String(url ?? '')));
});
route('DELETE', '/api/modules/:key', async (_req, res, [key]) => {
  await uninstall(key);
  send(res, 204, '');
});

// ---------- conexiones (credenciales por app; nunca se devuelven completas) ----------
// Solo se enmascaran los campos secretos (tokens, claves); subdominios y similares se muestran
const secretFields = () => Object.fromEntries(listModules().filter((m) => m.auth).map((m) => [m.key, m.auth!.fields.filter((f) => f.secret).map((f) => f.key)]));
route('GET', '/api/connections', async (_req, res) => send(res, 200, await listMasked(secretFields())));
route('PUT', '/api/connections/:app', async (req, res, [app]) => {
  const mod = listModules().find((m) => m.key === app);
  if (!mod?.auth) return send(res, 404, { error: 'Esa app no usa conexión' });
  const { values } = await json<{ values?: Record<string, string> }>(req);
  const allowed = new Set(mod.auth.fields.map((f) => f.key));
  await setConnection(app, Object.fromEntries(Object.entries(values ?? {}).filter(([k]) => allowed.has(k))));
  send(res, 200, (await listMasked(secretFields()))[app] ?? {});
});
route('DELETE', '/api/connections/:app', async (_req, res, [app]) => {
  await deleteConnection(app);
  send(res, 204, '');
});

// ---------- asistente de automatización ----------
route('POST', '/api/assistant/plan', async (req, res) => {
  const { text } = await json<{ text?: string }>(req);
  if (!text?.trim()) return send(res, 400, { error: 'Describe lo que quieres automatizar' });
  send(res, 201, await planFromText(text.trim()));
});
route('POST', '/api/assistant/chat', async (req, res) => {
  const { message, flowId } = await json<{ message?: string; flowId?: string }>(req);
  if (!message?.trim()) return send(res, 400, { error: 'Escribe un mensaje' });
  send(res, 200, await assistantTurn(message.trim(), flowId));
});

// ---------- flujos ----------
route('GET', '/api/flows', async (_req, res) => send(res, 200, await listFlows()));
route('POST', '/api/flows', async (req, res) => send(res, 201, await saveFlow({ ...(await json<Record<string, unknown>>(req)), id: undefined })));
route('GET', '/api/flows/:id', async (_req, res, [id]) => send(res, 200, await getFlow(id)));
route('PUT', '/api/flows/:id', async (req, res, [id]) => send(res, 200, await saveFlow({ ...(await json<Record<string, unknown>>(req)), id })));
route('DELETE', '/api/flows/:id', async (_req, res, [id]) => {
  await deleteFlow(id);
  send(res, 204, '');
});
route('POST', '/api/flows/:id/run', async (req, res, [id]) => {
  const { payload } = await json<{ payload?: unknown }>(req);
  send(res, 200, await runFlow(await getFlow(id), payload ?? { manual: true, ts: new Date().toISOString() }, 'manual'));
});
route('GET', '/api/flows/:id/runs', async (_req, res, [id]) => send(res, 200, await listRuns(id)));

// Datos para la pantalla "Conectar" (solo la interfaz local)
route('GET', '/api/connect', async (req, res) => {
  send(res, 200, { apiKey: getApiKey(), baseUrl: `http://${req.headers.host ?? `localhost:${PORT}`}`, root: ROOT });
});
route('POST', '/api/connect/rotate', async (_req, res) => send(res, 200, { apiKey: rotateApiKey() }));

// YAML de un tema pegado desde el editor de código de Copilot Studio
route('POST', '/api/import/topic', async (req, res) => {
  const { yaml, agentName, agentId } = await json<{ yaml: string; agentName?: string; agentId?: string }>(req);
  send(res, 200, await importTopicYaml(yaml, agentName, agentId));
});

// Webhook público de un flujo: /hooks/<id>. Responde con el resultado de la ejecución.
async function handleHook(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const flow = await getFlow(decodeURIComponent(id));
  const trig = flow.trigger ? getTrigger(flow.trigger.module, flow.trigger.key) : undefined;
  if (!flow.active || trig?.type !== 'webhook') return send(res, 404, { error: 'Este flujo no está activo o no usa un disparador webhook' });
  const url = new URL(req.url ?? '/', 'http://x');
  const secret = String(flow.trigger?.args?.secret ?? '');
  if (secret && url.searchParams.get('token') !== secret && req.headers['x-flow-token'] !== secret) return send(res, 401, { error: 'Token incorrecto' });
  const raw = (await readBody(req, 2 * 1024 * 1024)).toString('utf8');
  let body: unknown = raw;
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('json')) { try { body = JSON.parse(raw || '{}'); } catch { body = raw; } }
  else if (type.includes('x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/authorization|cookie|token/i.test(k)));
  const run = await runFlow(flow, { method: req.method, body, query: Object.fromEntries(url.searchParams), headers }, 'webhook');
  const last = [...run.steps].reverse().find((s) => s.status === 'ok');
  send(res, run.status === 'error' ? 500 : 200, { ok: run.status !== 'error', runId: run.id, status: run.status, output: last?.output ?? null });
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const safe = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) return send(res, 404, 'No encontrado', 'text/plain');
  // los logos no cambian entre ejecuciones: que el navegador los guarde un día
  if (safe.startsWith('/logos/')) res.setHeader('Cache-Control', 'public, max-age=86400');
  send(res, 200, await readFile(file), MIME[extname(file)] ?? 'application/octet-stream');
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (await handlePublic(req, res, path)) return;
    if (path.startsWith('/hooks/')) return await handleHook(req, res, path.slice(7));
    if (path.startsWith('/files/')) {
      const name = path.slice(7);
      const file = join(ROOT, 'data', 'files', name);
      if (!/^[\w-]+\.mp3$/.test(name) || !existsSync(file)) return send(res, 404, 'No encontrado', 'text/plain');
      return send(res, 200, await readFile(file), 'audio/mpeg');
    }
    // Login: toda la API de la interfaz pide sesión, salvo /api/auth/*
    if (path.startsWith('/api/')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido' });
      if (path === '/api/auth/info') return send(res, 200, await authInfo());
      if (path === '/api/auth/register' && req.method === 'POST') return send(res, 201, { user: await register(req, res, await json(req)) });
      if (path === '/api/auth/login' && req.method === 'POST') return send(res, 200, { user: await login(req, res, await json(req)) });
      if (path === '/api/auth/logout' && req.method === 'POST') { await logout(req, res); return send(res, 204, ''); }
      if (authEnabled) {
        const user = await currentUser(req);
        if (path === '/api/auth/me') return user ? send(res, 200, { user }) : send(res, 401, { error: 'Sin sesión' });
        if (!user) return send(res, 401, { error: 'Inicia sesión para continuar' });
      } else if (path === '/api/auth/me') return send(res, 200, { user: null, disabled: true });
    }
    for (const [method, re, h] of routes) {
      const m = path.match(re);
      if (m && req.method === method) return await h(req, res, m.slice(1).map(decodeURIComponent));
    }
    if (path.startsWith('/api/')) return send(res, 404, { error: 'Ruta no encontrada' });
    await serveStatic(req, res);
  } catch (err) {
    const e = err as Error & { status?: number; code?: string };
    const status = e.status ?? (e.code === 'ENOENT' ? 404 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message });
  }
}).listen(PORT, async () => {
  if (authEnabled) {
    try { await initAuth(); console.log(`Usuarios: MariaDB (${process.env.DB_NAME ?? 'agent_studio'}@${process.env.DB_HOST}) · registro ${process.env.AUTH_ALLOW_SIGNUP === 'false' ? 'cerrado' : 'abierto'}`); }
    catch (e) { console.error(`✖ No se pudo conectar a MariaDB: ${(e as Error).message}`); }
  } else console.log('⚠ Sin DB_HOST: la app funciona sin inicio de sesión');
  await loadModules();
  startScheduler();
  { const l = listModules(); const n = (b: string) => l.filter((m) => m.badge === b).length; console.log(`Módulos: ${l.length} (${n("API")} APIs, ${n("MCP")} servidores MCP, ${l.length - n("API") - n("MCP")} nativos)${loadErrors.length ? ` · ${loadErrors.length} con errores` : ""}`); }
  console.log(`Agent Studio en http://localhost:${PORT}`);
  getApiKey(); // genera data/api-key si no existe
  console.log(`API REST: http://localhost:${PORT}/v1  ·  MCP: http://localhost:${PORT}/mcp  ·  clave en data/api-key`);
  if (useNanoclaw()) console.log(`Backend: NanoClaw (${process.env.NANOCLAW_PROVIDER ?? 'opencode'} · ${process.env.NANOCLAW_MODEL ?? 'deepseek/deepseek-chat'})`);
  else if (!llmConfigured()) console.log('⚠ Falta DEEPSEEK_API_KEY (copia .env.example a .env)');
  if (!voiceConfigured()) console.log('⚠ Falta ELEVENLABS_API_KEY: la voz estará desactivada');
});
