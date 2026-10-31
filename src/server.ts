// Servidor HTTP: API REST + interfaz web. Sin frameworks, solo node:http.
//
// /api/*     API interna de la interfaz: sesión + empresa activa + permisos por ruta
// /v1, /mcp  API pública: clave de API por empresa con scopes (public-api.ts)
// /hooks/<empresa>/<id>  webhooks de los flujos
// /s/<empresa>  webs de las empresas con su tienda (sites/routes.ts)
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { ROOT, listAgents, getAgent, saveAgent, saveAgentYaml, deleteAgent, uniqueId, countAgents } from './store.ts';
import { handleTurn, resetSession } from './engine.ts';
import { useClaudeCode, useOrchestrator, agentBackend, status as claudeCodeStatus, syncAgent } from './claude-code.ts';
import { jevConfigured } from './jev.ts';
import { textToSpeech, speechToText, listVoices, voiceConfigured } from './voice.ts';
import { llmConfigured, DEFAULT_MODEL, llmStatus } from './llm.ts';
import { importPath, importTopicYaml } from './importer.ts';
import type { AgentDef } from './types.ts';
import { handlePublic } from './public-api.ts';
import { authEnabled, initAuth, currentSession, register, login, logout, authInfo, sameOrigin, setActiveTenant } from './auth.ts';
import { loadModules, listModules, installFromUrl, uninstall, loadErrors, getTrigger } from './modules/registry.ts';
import { listFlows, getFlow, saveFlow, deleteFlow, runFlow, listRuns, startScheduler, setTenantFilter, type Flow } from './flows.ts';
import { setConnection, deleteConnection, listMasked } from './connections.ts';
import { planFromText, assistantTurn } from './assistant.ts';
import { recordTts, clearDemo, writeDemo, readEvents } from './metrics.ts';
import { aggregate, makeDemo } from './metrics-report.ts';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG, tenantDataPath } from './tenancy/paths.ts';
import { getTenantBySlug, isTenantActive } from './tenancy/tenants.ts';
import { needsTenancyMigration } from './tenancy/migrate.ts';
import { contextForUser, localContext, systemContext, type Ctx } from './authz/context.ts';
import { can, assertCan } from './authz/can.ts';
import { audit } from './tenancy/audit.ts';
import { invalidatePermissions } from './authz/cache.ts';
import { routes, route, send, sendBig, json, readBody, ipOf, query } from './http.ts';
import { registerAdminRoutes } from './admin-routes.ts';
import { registerSiteRoutes, handleSites } from './sites/routes.ts';
import { localApiKey } from './tenancy/apikeys.ts';
import { blockedFlowFeatures, filterModulesForTenant } from './features/enforce.ts';

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

async function loadCatalog(): Promise<{ functions: string[]; industries: string[]; templates: AgentDef[] }> {
  return YAML.parse(await readFile(join(ROOT, 'catalog', 'catalog.yaml'), 'utf8'));
}

// Límite de agentes del plan
async function assertAgentQuota(ctx: Ctx, adding = 1): Promise<void> {
  const max = ctx.plan.maxAgents;
  if (max !== null && (await countAgents(ctx.tenantId)) + adding > max) throw Object.assign(new Error(`Tu plan (${ctx.plan.name}) permite ${max} agentes. Mejora el plan para crear más.`), { status: 403 });
}

const actor = (ctx: Ctx) => ({ actor: ctx.actor, ip: ctx.ip });

route('GET', '/api/status', { noTenant: true }, async (_req, res) => {
  send(res, 200, {
    backend: agentBackend(),
    jev: jevConfigured(),
    llm: llmConfigured(),
    model: DEFAULT_MODEL,
    llmRoutes: llmStatus(),
    voice: voiceConfigured(),
    ...(useClaudeCode() || useOrchestrator() ? { claudeCode: claudeCodeStatus() } : {}),
  });
});

route('GET', '/api/catalog', { perm: 'agents.read' }, async (_req, res) => send(res, 200, await loadCatalog()));

route('POST', '/api/catalog/:id/use', { perm: 'agents.manage' }, async (_req, res, [id], ctx) => {
  const tpl = (await loadCatalog()).templates.find((t) => t.id === id);
  if (!tpl) return send(res, 404, { error: 'Plantilla no encontrada' });
  await assertAgentQuota(ctx);
  const agent = await saveAgent(ctx.tenantId, { ...structuredClone(tpl), id: await uniqueId(ctx.tenantId, tpl.id), source: 'template' });
  send(res, 201, agent);
});

route('GET', '/api/agents', { perm: 'agents.read' }, async (_req, res, _p, ctx) => send(res, 200, await listAgents(ctx.tenantId)));

route('POST', '/api/agents', { perm: 'agents.manage' }, async (req, res, _p, ctx) => {
  const body = await json<Partial<AgentDef>>(req);
  await assertAgentQuota(ctx);
  const agent = await saveAgent(ctx.tenantId, {
    name: body.name ?? 'Nuevo agente',
    instructions: body.instructions ?? 'Eres un asistente útil.',
    ...body,
    id: await uniqueId(ctx.tenantId, body.name ?? 'nuevo-agente'),
  } as AgentDef);
  send(res, 201, agent);
});

route('GET', '/api/agents/:id', { perm: 'agents.read' }, async (_req, res, [id], ctx) => send(res, 200, await getAgent(ctx.tenantId, id)));

route('GET', '/api/agents/:id/yaml', { perm: 'agents.read' }, async (_req, res, [id], ctx) => {
  const a = await getAgent(ctx.tenantId, id);
  const { id: _omit, ...rest } = a;
  send(res, 200, YAML.stringify(rest, { lineWidth: 0 }), 'text/yaml; charset=utf-8');
});

route('PUT', '/api/agents/:id/yaml', { perm: 'agents.manage' }, async (req, res, [id], ctx) => {
  const agent = await saveAgentYaml(ctx.tenantId, id, (await readBody(req)).toString('utf8'));
  // Mantener al día el CLAUDE.md de Claude Code
  if (useClaudeCode() || useOrchestrator()) await syncAgent(agent);
  send(res, 200, agent);
});

route('POST', '/api/agents/:id/claude-code/sync', { perm: 'agents.manage' }, async (_req, res, [id], ctx) => {
  const r = await syncAgent(await getAgent(ctx.tenantId, id));
  // La ruta en disco no sale de la empresa: solo el nombre del archivo
  send(res, 200, { file: `claude-code/${id}/CLAUDE.md`, syncedAt: r.syncedAt, changed: r.changed });
});

route('DELETE', '/api/agents/:id', { perm: 'agents.manage' }, async (_req, res, [id], ctx) => {
  await deleteAgent(ctx.tenantId, id);
  send(res, 204, '');
});

route('POST', '/api/agents/:id/chat', { perm: 'agents.read' }, async (req, res, [id], ctx) => {
  const { message = '', sessionId } = await json<{ message?: string; sessionId?: string }>(req);
  send(res, 200, await handleTurn(await getAgent(ctx.tenantId, id), sessionId, message));
});

route('POST', '/api/sessions/:sid/reset', { perm: 'agents.read' }, async (_req, res, [sid], ctx) => {
  resetSession(ctx.tenantId, sid);
  send(res, 204, '');
});

route('POST', '/api/tts', { perm: 'agents.read' }, async (req, res, _p, ctx) => {
  const { text, agentId } = await json<{ text: string; agentId?: string }>(req);
  const agent = agentId ? await getAgent(ctx.tenantId, agentId) : undefined;
  const t0 = performance.now();
  const audio = await textToSpeech(text, agent?.voice?.voiceId, agent?.voice?.model);
  void recordTts(ctx.tenantId, agent?.id, text.length, performance.now() - t0);
  send(res, 200, audio, 'audio/mpeg');
});

route('POST', '/api/stt', { perm: 'agents.read' }, async (req, res) => {
  const audio = await readBody(req);
  const lang = query(req).get('lang') ?? undefined;
  send(res, 200, { text: await speechToText(audio, req.headers['content-type'] ?? 'audio/webm', lang) });
});

route('GET', '/api/voices', { perm: 'agents.read' }, async (_req, res) => send(res, 200, await listVoices()));

// Subida de la solución exportada de Copilot Studio (.zip) en el cuerpo
route('POST', '/api/import/solution', { perm: 'agents.manage' }, async (req, res, _p, ctx) => {
  await assertAgentQuota(ctx);
  const dir = await mkdtemp(join(tmpdir(), 'cs-upload-'));
  try {
    const file = join(dir, 'solution.zip');
    await writeFile(file, await readBody(req, 200 * 1024 * 1024));
    send(res, 200, await importPath(ctx.tenantId, file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// YAML de un tema pegado desde el editor de código de Copilot Studio
route('POST', '/api/import/topic', { perm: 'agents.manage' }, async (req, res, _p, ctx) => {
  const { yaml, agentName, agentId } = await json<{ yaml: string; agentName?: string; agentId?: string }>(req);
  if (!agentId) await assertAgentQuota(ctx);
  send(res, 200, await importTopicYaml(ctx.tenantId, yaml, agentName, agentId));
});

// Métricas (panel)
route('GET', '/api/metrics', { perm: 'metrics.read' }, async (req, res, _p, ctx) => {
  const q = query(req).get('range');
  const range = q === '24h' || q === '30d' ? q : '7d';
  const { events, demo } = await readEvents(ctx.tenantId);
  // Las plantillas aportan nombres legibles a los agentes de los datos de ejemplo
  send(res, 200, aggregate(events, [...(await listAgents(ctx.tenantId)), ...(await loadCatalog()).templates], range, demo));
});
route('POST', '/api/metrics/demo', { perm: 'agents.manage' }, async (_req, res, _p, ctx) => {
  await writeDemo(ctx.tenantId, makeDemo((await listAgents(ctx.tenantId)).map((a) => a.id)));
  send(res, 201, { ok: true });
});
route('DELETE', '/api/metrics/demo', { perm: 'agents.manage' }, async (_req, res, _p, ctx) => {
  await clearDemo(ctx.tenantId);
  send(res, 204, '');
});

// ---------- módulos de automatización (apps) ----------
// La lista oculta los pasos de los módulos de negocio que la empresa no tiene activos.
// Instalar o recargar módulos ejecuta código en el servidor: solo el superadmin.
const modulesPayload = async (ctx: Ctx) => ({ modules: await filterModulesForTenant(ctx.tenantId, listModules()), errors: ctx.user?.isPlatformAdmin || ctx.local ? loadErrors : [] });
route('GET', '/api/modules', { perm: 'flows.read' }, async (req, res, _p, ctx) => sendBig(req, res, 200, await modulesPayload(ctx)));
route('POST', '/api/modules/reload', { platform: true }, async (req, res, _p, ctx) => {
  await loadModules();
  invalidatePermissions();
  sendBig(req, res, 200, await modulesPayload(ctx));
});
route('POST', '/api/modules/install', { platform: true }, async (req, res, _p, ctx) => {
  const { url } = await json<{ url?: string }>(req);
  const r = await installFromUrl(String(url ?? ''));
  await audit({ tenantId: null, ...actor(ctx), action: 'module.installed', target: `module:${r.key}`, after: { url } });
  send(res, 201, r);
});
route('DELETE', '/api/modules/:key', { platform: true }, async (_req, res, [key], ctx) => {
  await uninstall(key);
  await audit({ tenantId: null, ...actor(ctx), action: 'module.uninstalled', target: `module:${key}` });
  send(res, 204, '');
});

// ---------- conexiones (credenciales por app; nunca se devuelven completas) ----------
// Solo se enmascaran los campos secretos (tokens, claves); subdominios y similares se muestran
const secretFields = () => Object.fromEntries(listModules().filter((m) => m.auth).map((m) => [m.key, m.auth!.fields.filter((f) => f.secret).map((f) => f.key)]));
route('GET', '/api/connections', { perm: 'flows.read' }, async (_req, res, _p, ctx) => send(res, 200, await listMasked(ctx.tenantId, secretFields())));
route('PUT', '/api/connections/:app', { perm: 'tenant.connections.manage' }, async (req, res, [app], ctx) => {
  const mod = listModules().find((m) => m.key === app);
  if (!mod?.auth) return send(res, 404, { error: 'Esa app no usa conexión' });
  const { values } = await json<{ values?: Record<string, string> }>(req);
  const allowed = new Set(mod.auth.fields.map((f) => f.key));
  const r = await setConnection(ctx.tenantId, app, Object.fromEntries(Object.entries(values ?? {}).filter(([k]) => allowed.has(k))));
  invalidatePermissions(ctx.tenantId); // puede cambiar el estado "Requiere configuración" de un módulo
  // En la auditoría solo van los nombres de los campos, nunca los valores
  await audit({ tenantId: ctx.tenantId, ...actor(ctx), action: 'connection.saved', target: `connection:${app}`, before: { fields: r.before }, after: { fields: r.after } });
  send(res, 200, (await listMasked(ctx.tenantId, secretFields()))[app] ?? {});
});
route('DELETE', '/api/connections/:app', { perm: 'tenant.connections.manage' }, async (_req, res, [app], ctx) => {
  if (await deleteConnection(ctx.tenantId, app)) {
    invalidatePermissions(ctx.tenantId);
    await audit({ tenantId: ctx.tenantId, ...actor(ctx), action: 'connection.deleted', target: `connection:${app}` });
  }
  send(res, 204, '');
});

// ---------- asistente de automatización ----------
route('POST', '/api/assistant/plan', { perm: 'flows.manage' }, async (req, res, _p, ctx) => {
  const { text } = await json<{ text?: string }>(req);
  if (!text?.trim()) return send(res, 400, { error: 'Describe lo que quieres automatizar' });
  send(res, 201, await planFromText(ctx.tenantId, text.trim()));
});
route('POST', '/api/assistant/chat', { perm: 'flows.manage' }, async (req, res, _p, ctx) => {
  const { message, flowId } = await json<{ message?: string; flowId?: string }>(req);
  if (!message?.trim()) return send(res, 400, { error: 'Escribe un mensaje' });
  send(res, 200, await assistantTurn(ctx.tenantId, message.trim(), flowId));
});

// ---------- flujos ----------
route('GET', '/api/flows', { perm: 'flows.read' }, async (_req, res, _p, ctx) => send(res, 200, await listFlows(ctx.tenantId)));
route('POST', '/api/flows', { perm: 'flows.manage' }, async (req, res, _p, ctx) => send(res, 201, await saveFlow(ctx.tenantId, { ...(await json<Record<string, unknown>>(req)), id: undefined, paused: undefined })));
route('GET', '/api/flows/:id', { perm: 'flows.read' }, async (_req, res, [id], ctx) => send(res, 200, await getFlow(ctx.tenantId, id)));
route('PUT', '/api/flows/:id', { perm: 'flows.manage' }, async (req, res, [id], ctx) => {
  const current = await getFlow(ctx.tenantId, id); // solo se edita un flujo que ya existe en esta empresa
  send(res, 200, await saveFlow(ctx.tenantId, { ...(await json<Record<string, unknown>>(req)), id, paused: current.paused }));
});
route('DELETE', '/api/flows/:id', { perm: 'flows.manage' }, async (_req, res, [id], ctx) => {
  await deleteFlow(ctx.tenantId, id);
  send(res, 204, '');
});
route('POST', '/api/flows/:id/run', { perm: 'flows.manage' }, async (req, res, [id], ctx) => {
  const { payload } = await json<{ payload?: unknown }>(req);
  send(res, 200, await runFlow(await getFlow(ctx.tenantId, id), payload ?? { manual: true, ts: new Date().toISOString() }, 'manual'));
});
route('GET', '/api/flows/:id/runs', { perm: 'flows.read' }, async (_req, res, [id], ctx) => send(res, 200, await listRuns(ctx.tenantId, id)));

// Datos para la pantalla "Conectar". Las claves de API se gestionan en Configuración → Claves de API.
route('GET', '/api/connect', { perm: 'agents.read' }, async (req, res, _p, ctx) => {
  send(res, 200, { baseUrl: `http://${req.headers.host ?? `localhost:${PORT}`}`, root: ROOT, tenantSlug: ctx.tenant.slug, local: ctx.local });
});

registerAdminRoutes();
registerSiteRoutes();

// Webhook público de un flujo: /hooks/<empresa>/<id>. Responde con el resultado.
// La ruta antigua /hooks/<id> sigue funcionando solo para la empresa Default (obsoleta).
async function handleHook(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
  const parts = rest.split('/').filter(Boolean).map(decodeURIComponent);
  let tenantId: number;
  let id: string;
  const notFound = () => send(res, 404, { error: 'Este flujo no está activo o no usa un disparador webhook' });
  if (parts.length === 2) {
    const tenant = await getTenantBySlug(parts[0]);
    if (!tenant || tenant.status !== 'active') return notFound();
    tenantId = tenant.id;
    id = parts[1];
  } else if (parts.length === 1) {
    tenantId = DEFAULT_TENANT_ID;
    id = parts[0];
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', `</hooks/${DEFAULT_TENANT_SLUG}/${encodeURIComponent(id)}>; rel="successor-version"`);
    console.warn(`[webhooks] /hooks/${id} está obsoleta: usa /hooks/${DEFAULT_TENANT_SLUG}/${id}`);
  } else return send(res, 404, { error: 'Ruta no encontrada' });
  let flow: Flow;
  try { flow = await getFlow(tenantId, id); } catch { return notFound(); }
  const trig = flow.trigger ? getTrigger(flow.trigger.module, flow.trigger.key) : undefined;
  if (!flow.active || trig?.type !== 'webhook') return notFound();
  const url = new URL(req.url ?? '/', 'http://x');
  const secret = String(flow.trigger?.args?.secret ?? '');
  if (secret && url.searchParams.get('token') !== secret && req.headers['x-flow-token'] !== secret) return send(res, 401, { error: 'Token incorrecto' });
  // Un flujo que usa un módulo desactivado responde 403 y queda registrado
  const blocked = await blockedFlowFeatures(tenantId, flow);
  if (blocked.length) {
    await audit({ tenantId, actor: { type: 'system' }, ip: ipOf(req), action: 'webhook.blocked', target: `flow:${flow.id}`, after: { features: blocked.map((b) => b.feature), reason: blocked[0].message } });
    return send(res, 403, { error: blocked[0].message, features: blocked.map((b) => b.feature) });
  }
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

// ---------- /api: sesión → empresa activa → permisos ----------
async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido' });
  if (path === '/api/auth/info') return send(res, 200, await authInfo(query(req).get('invite')));
  if (path === '/api/auth/register' && req.method === 'POST') return send(res, 201, { user: await register(req, res, await json(req)) });
  if (path === '/api/auth/login' && req.method === 'POST') return send(res, 200, { user: await login(req, res, await json(req)) });
  if (path === '/api/auth/logout' && req.method === 'POST') { await logout(req, res); return send(res, 204, ''); }

  let ctx: Ctx | null;
  let sessionHash: string | null = null;
  let noTenantUser = null;
  if (authEnabled) {
    const session = await currentSession(req);
    if (path === '/api/auth/me') return session ? send(res, 200, { user: session.user }) : send(res, 401, { error: 'Sin sesión' });
    if (!session) return send(res, 401, { error: 'Inicia sesión para continuar' });
    sessionHash = session.tokenHash;
    const c = await contextForUser(session.user, session.activeTenantId, ipOf(req));
    if (c.tenantId === null) { ctx = null; noTenantUser = c; }
    else {
      ctx = c;
      if (session.activeTenantId !== c.tenantId) await setActiveTenant(session.tokenHash, c.tenantId);
    }
  } else {
    if (path === '/api/auth/me') return send(res, 200, { user: null, disabled: true });
    ctx = localContext(ipOf(req));
  }
  (req as IncomingMessage & { session?: unknown }).session = { tokenHash: sessionHash, noTenant: noTenantUser };

  for (const r of routes) {
    const m = path.match(r.re);
    if (!m || req.method !== r.method) continue;
    if (!ctx && !r.opts.noTenant) return send(res, 403, { error: 'No perteneces a ninguna empresa todavía. Pide una invitación a su administrador.', code: 'no_tenant' });
    if (r.opts.platform && !ctx?.user?.isPlatformAdmin && !(ctx?.local)) return send(res, 403, { error: 'Solo el administrador de la plataforma puede hacer esto.' });
    if (ctx && !r.opts.noTenant && !r.opts.platform) {
      if (r.opts.anyPerm && !r.opts.anyPerm.some((p) => ctx!.permissions.has(p))) return send(res, 403, { error: 'No tienes permiso para esto.', code: 'permission' });
      const d = await can(ctx, { feature: r.opts.feature, permission: r.opts.perm });
      if (!d.ok) return send(res, d.status, { error: d.message, code: d.code });
    }
    return await r.handler(req, res, m.slice(1).map(decodeURIComponent), ctx as Ctx);
  }
  return send(res, 404, { error: 'Ruta no encontrada' });
}

export function createAppServer(): Server {
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (await handlePublic(req, res, path)) return;
      if (path.startsWith('/hooks/')) return await handleHook(req, res, path.slice(7));
      // Webs de las empresas (/s/<empresa>, dominios propios), OAuth y avisos de cobro
      if (await handleSites(req, res, path)) return;
      // Audio generado por los flujos: /files/<tenant_id>/<uuid>.mp3 (nombre aleatorio, no adivinable)
      if (path.startsWith('/files/')) {
        const m = path.match(/^\/files\/([1-9]\d*)\/([\w-]+\.mp3)$/);
        const file = m ? tenantDataPath(Number(m[1]), 'files', m[2]) : '';
        if (!m || !existsSync(file)) return send(res, 404, 'No encontrado', 'text/plain');
        return send(res, 200, await readFile(file), 'audio/mpeg');
      }
      if (path.startsWith('/api/')) return await handleApi(req, res, path);
      await serveStatic(req, res);
    } catch (err) {
      const e = err as Error & { status?: number; code?: string; [k: string]: unknown };
      const status = e.status ?? (e.code === 'ENOENT' ? 404 : 500);
      if (status === 500) console.error(e);
      // Datos extra para la interfaz (p. ej. qué dependencias faltan)
      const extra = Object.fromEntries(['code', 'requires', 'dependents', 'feature', 'errors'].filter((k) => e[k] !== undefined && typeof e[k] !== 'function').map((k) => [k, e[k]]));
      if (!res.headersSent) send(res, status, { error: e.message, ...(e.code === 'ENOENT' ? {} : extra) });
    }
  });
}

export async function startServer(port = PORT): Promise<Server> {
  if (authEnabled) {
    try { await initAuth(); console.log(`Usuarios: MariaDB (${process.env.DB_NAME ?? 'agent_studio'}@${process.env.DB_HOST}) · registro ${process.env.AUTH_ALLOW_SIGNUP === 'false' ? 'cerrado' : 'abierto'}`); }
    catch (e) { console.error(`✖ No se pudo conectar a MariaDB: ${(e as Error).message}`); }
  } else {
    localApiKey(); // como antes: genera data/api-key (clave de la empresa Default) si no existe
    console.log('⚠ Sin DB_HOST: la app funciona sin inicio de sesión (una sola empresa) · clave de API en data/api-key');
  }
  await loadModules();
  setTenantFilter(isTenantActive);
  startScheduler();
  if (await needsTenancyMigration()) console.warn('⚠ Hay datos en el formato antiguo (una sola empresa). Ejecuta: npm run migrate:tenancy');
  const server = createAppServer();
  await new Promise<void>((ok) => server.listen(port, ok));
  const l = listModules();
  const n = (b: string) => l.filter((m) => m.badge === b).length;
  console.log(`Módulos: ${l.length} (${n('API')} APIs, ${n('MCP')} servidores MCP, ${l.length - n('API') - n('MCP')} nativos)${loadErrors.length ? ` · ${loadErrors.length} con errores` : ''}`);
  console.log(`CrawStudio A.I en http://localhost:${port}`);
  console.log(`API REST: http://localhost:${port}/v1  ·  MCP: http://localhost:${port}/mcp  ·  claves de API en Configuración → Claves de API`);
  if (useOrchestrator()) console.log(`Backend: orquestado · Jev ${jevConfigured() ? 'decide' : 'sin clave (decide el orquestador)'} · orquestador ${llmStatus().default} · Claude Code ${claudeCodeStatus().model}`);
  if (useClaudeCode()) {
    const st = claudeCodeStatus();
    console.log(`Backend: Claude Code (${st.model}${st.builtinTools.length ? ` · herramientas: ${st.builtinTools.join(', ')}` : ''})`);
    if (!st.apiKey) console.log('⚠ No se detectan credenciales para Claude Code: define ANTHROPIC_API_KEY (o inicia sesión con claude)');
  } else if (!llmConfigured()) console.log('⚠ No hay ningún modelo configurado: define DEEPSEEK_API_KEY, QWEN_API_KEY u otro proveedor (copia .env.example a .env)');
  else { const st = llmStatus(); console.log(`LLM: ${st.default} · clasificar: ${st.classify}${st.fallbacks.length ? ` · respaldo: ${st.fallbacks.join(', ')}` : ''}`); }
  if (!voiceConfigured()) console.log('⚠ Falta ELEVENLABS_API_KEY: la voz estará desactivada');
  return server;
}

// Solo arranca si se ejecuta directamente (las pruebas importan createAppServer)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void startServer();

export { assertCan, systemContext };
