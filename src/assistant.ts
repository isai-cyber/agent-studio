// Asistente de automatización: convierte una frase en un flujo (y un agente si hace falta)
// y lo va modificando por chat ("añade un correo", "quita el paso 2", "publícalo").
//
// Si hay LLM configurado (DeepSeek), lo usa para planificar con el catálogo de módulos;
// si no, o si la respuesta no es válida, usa reglas propias (palabras clave en español
// e inglés). En ambos casos el resultado se valida contra los módulos instalados.
import { randomUUID } from 'node:crypto';
import { listModules, getTrigger, getAction } from './modules/registry.ts';
import { listFlows, getFlow, saveFlow, type Flow, type FlowStep } from './flows.ts';
import { listAgents, saveAgent, uniqueId, slugify } from './store.ts';
import { chat, llmConfigured } from './llm.ts';
import { getConnection } from './connections.ts';
import type { AgentDef } from './types.ts';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const has = (t: string, re: RegExp) => re.test(t);
const sid = () => randomUUID().slice(0, 6);

// ---------- disparadores ----------

interface TriggerPick { module: string; key: string; args: Record<string, unknown>; app?: string; summary: string; text: string; label: string }

const TRIGGERS: { re: RegExp; pick: () => TriggerPick }[] = [
  { re: /escal|(hablar|pasar).{0,20}(persona|humano)|agente humano/, pick: () => ({ module: 'agent-studio', key: 'agent-turn', args: { topic: 'Hablar con una persona' }, summary: '{{trigger.agentName}} necesita a una persona. Cliente: "{{trigger.message}}"', text: '{{trigger.message}}', label: 'un agente escala a una persona' }) },
  { re: /telegram/, pick: () => ({ module: 'telegram', key: 'new-message', args: {}, app: 'telegram', summary: '{{trigger.from}} escribió por Telegram: {{trigger.text}}', text: '{{trigger.text}}', label: 'llega un mensaje a tu bot de Telegram' }) },
  { re: /shopify/, pick: () => ({ module: 'shopify', key: 'new-order', args: {}, app: 'shopify', summary: 'Nuevo pedido {{trigger.name}} de {{trigger.customer}} por {{trigger.total}} {{trigger.currency}}', text: 'Pedido {{trigger.name}} de {{trigger.customer}}', label: 'entra un pedido en Shopify' }) },
  { re: /woocommerce|woo commerce/, pick: () => ({ module: 'woocommerce', key: 'new-order', args: {}, app: 'woocommerce', summary: 'Nuevo pedido #{{trigger.number}} por {{trigger.total}} {{trigger.currency}} ({{trigger.email}})', text: 'Pedido #{{trigger.number}}', label: 'entra un pedido en WooCommerce' }) },
  { re: /stripe|(nuevo|recib\w*|llega\w*) (un )?pago/, pick: () => ({ module: 'stripe', key: 'new-charge', args: {}, app: 'stripe', summary: 'Nuevo pago de {{trigger.amount}} {{trigger.currency}} ({{trigger.email}})', text: 'Pago de {{trigger.amount}} {{trigger.currency}}', label: 'recibes un pago en Stripe' }) },
  { re: /typeform|formulario/, pick: () => ({ module: 'typeform', key: 'new-response', args: {}, app: 'typeform', summary: 'Nueva respuesta del formulario: {{trigger.answers}}', text: '{{trigger.answers}}', label: 'alguien responde tu formulario' }) },
  { re: /hubspot/, pick: () => ({ module: 'hubspot', key: 'new-contact', args: {}, app: 'hubspot', summary: 'Nuevo contacto en HubSpot: {{trigger.firstname}} {{trigger.lastname}} ({{trigger.email}})', text: '{{trigger.email}}', label: 'se crea un contacto en HubSpot' }) },
  { re: /github|issue|incidencia/, pick: () => ({ module: 'github', key: 'new-issue', args: {}, app: 'github', summary: 'Nueva incidencia #{{trigger.number}}: {{trigger.title}} ({{trigger.url}})', text: '{{trigger.title}}\n{{trigger.body}}', label: 'se abre una incidencia en GitHub' }) },
  { re: /\brss\b|feed|blog|noticia|podcast|youtube/, pick: () => ({ module: 'rss', key: 'new-item', args: {}, summary: 'Nueva publicación: {{trigger.title}} {{trigger.link}}', text: '{{trigger.title}}: {{trigger.summary}}', label: 'hay una publicación nueva en un feed' }) },
  { re: /notion/, pick: () => ({ module: 'notion', key: 'new-page', args: {}, app: 'notion', summary: 'Nueva página en Notion: {{trigger.url}}', text: '{{trigger.properties}}', label: 'se crea una página en Notion' }) },
  { re: /airtable/, pick: () => ({ module: 'airtable', key: 'new-record', args: {}, app: 'airtable', summary: 'Nuevo registro en Airtable: {{trigger.id}}', text: '{{trigger}}', label: 'se crea un registro en Airtable' }) },
  { re: /cada (dia|manana|noche|hora|semana|lunes|martes|miercoles|jueves|viernes)|diari|todos los dias|cada \d+ (min|hora)|program/, pick: () => ({ module: 'core', key: 'schedule', args: { everyMinutes: 1440 }, summary: 'Resumen programado', text: '', label: 'llega la hora programada' }) },
  { re: /webhook|mi (web|pagina|landing|app)|desde (mi|una) (web|app)|whatsapp|api externa|zapier|make|n8n/, pick: () => ({ module: 'core', key: 'webhook', args: {}, summary: 'Nuevo evento: {{trigger.body}}', text: '{{trigger.body.mensaje}}', label: 'llega una petición a tu webhook' }) },
];

function everyMinutes(t: string): number {
  const m = t.match(/cada (\d+) (min|hora)/);
  if (m) return Number(m[1]) * (m[2].startsWith('hora') ? 60 : 1);
  if (/cada hora/.test(t)) return 60;
  if (/cada semana|cada lunes|cada martes|cada miercoles|cada jueves|cada viernes/.test(t)) return 10080;
  return 1440;
}

// Parte de la frase que describe el disparador: lo que va tras "cuando / cada vez que / si llega"
function triggerClause(t: string): string {
  const m = t.match(/(cuando|cada vez que|al recibir|si llega|si recibo|whenever|when)\s+(.+?)(?:,|\s+(?:envia|enviar|manda|mandar|avisa|avisar|crea|crear|guarda|guardar|anade|añade|agrega|responde|responder|contesta|notifica|publica|registra|usa|usar|consulta|consultar|llama|llamar|busca|buscar|sube|subir|actualiza|actualizar|lee|leer|obten|then)\b|$)/);
  if (m) return m[2];
  const c = t.match(/(cada (?:dia|manana|noche|hora|semana|lunes|martes|miercoles|jueves|viernes|\d+ \w+)|diari\w*|todos los dias)/);
  return c ? c[1] : t;
}

function pickTrigger(t: string): TriggerPick {
  const clause = triggerClause(t);
  for (const tr of TRIGGERS) if (tr.re.test(clause)) {
    const p = tr.pick();
    if (p.key === 'schedule') p.args = { everyMinutes: everyMinutes(t) };
    return p;
  }
  // Sin disparador claro: si parece un asistente conversacional, por webhook; si no, manual
  return /atiend|respond|contest|client|whatsapp/.test(t) ? TRIGGERS.find((x) => x.re.source.startsWith('webhook'))!.pick() : { module: 'core', key: 'manual', args: {}, summary: 'Ejecución manual', text: '', label: 'lo ejecutas a mano (o por API)' };
}

// ---------- acciones ----------

interface Ctx { trig: TriggerPick; agentId?: string; prev: FlowStep[]; text: string; urls: string[] }

type ActionRule = { re: RegExp; app?: string; build: (c: Ctx) => Omit<FlowStep, 'id'> & { id?: string } };

// Lo que produjo el último paso, para encadenarlo (resumir, traducir...)
const lastOutput = (c: Ctx): string => {
  const last = c.prev[c.prev.length - 1];
  if (!last) return c.trig.text || c.trig.summary;
  const field = last.key === 'list-tools' || last.key === 'list-operations' ? '' : ({ mcp: 'text', http: 'data', openapi: 'data', 'agent-studio': 'reply', ia: 'text', 'apis-publicas': 'resumen', formato: 'text' } as Record<string, string>)[last.module] ?? '';
  return field ? `{{steps.${last.id}.${field}}}` : `{{steps.${last.id}}}`;
};

const msg = (c: Ctx) => {
  const last = [...c.prev].reverse().find((s) => s.module === 'ia' || s.module === 'agent-studio' || s.module === 'apis-publicas');
  if (last?.module === 'agent-studio') return `${c.trig.summary}\nRespuesta del agente: {{steps.${last.id}.reply}}`;
  if (last?.module === 'ia') return `{{steps.${last.id}.text}}`;
  if (last?.module === 'apis-publicas') return `{{steps.${last.id}.resumen}}`;
  return c.trig.summary;
};

const ACTIONS: ActionRule[] = [
  { re: /clima|tiempo (que hace|en)|temperatura|weather/, build: () => ({ module: 'apis-publicas', key: 'weather', name: 'Consultar el clima', args: { city: 'Ciudad de México' } }) },
  { re: /tipo de cambio|dolar|divisa|exchange rate/, build: () => ({ module: 'apis-publicas', key: 'exchange', name: 'Tipo de cambio', args: { from: 'USD', to: 'MXN', amount: 1 } }) },
  { re: /resum|summar/, build: (c) => ({ module: 'ia', key: 'generate', name: 'Resumir con IA', args: { prompt: `Resume en 2 frases, en español: ${lastOutput(c)}` } }) },
  { re: /clasific|categoriz|prioriz/, build: (c) => ({ module: 'ia', key: 'classify', name: 'Clasificar con IA', args: { text: lastOutput(c), categories: 'ventas, soporte, queja, otro' } }) },
  { re: /tradu/, build: (c) => ({ module: 'ia', key: 'generate', name: 'Traducir con IA', args: { prompt: `Traduce al inglés: ${lastOutput(c)}` } }) },
  { re: /atiend|respond|contest|agente|asistente|chatbot|bot que/, build: (c) => ({ module: 'agent-studio', key: 'chat', name: 'Responder con el agente', args: { agentId: c.agentId ?? '', message: c.trig.text || '{{trigger.body.mensaje}}' } }) },
  { re: /slack/, app: 'slack', build: (c) => ({ module: 'slack', key: 'send', name: 'Avisar en Slack', args: { channel: '#general', text: msg(c) } }) },
  { re: /discord/, build: (c) => ({ module: 'mensajeria', key: 'discord', name: 'Avisar en Discord', args: { webhookUrl: '{{env.FLOW_DISCORD_WEBHOOK}}', content: msg(c) } }) },
  { re: /teams/, build: (c) => ({ module: 'teams', key: 'send', name: 'Avisar en Teams', args: { webhookUrl: '', text: msg(c) } }) },
  { re: /google chat/, build: (c) => ({ module: 'google-chat', key: 'send', name: 'Avisar en Google Chat', args: { webhookUrl: '', text: msg(c) } }) },
  { re: /telegram/, app: 'telegram', build: (c) => ({ module: 'telegram', key: 'send', name: 'Enviar por Telegram', args: { chatId: c.trig.module === 'telegram' ? '{{trigger.chatId}}' : '', text: c.trig.module === 'telegram' ? replyOrMsg(c) : msg(c) } }) },
  { re: /whatsapp/, app: 'whatsapp', build: (c) => ({ module: 'whatsapp', key: 'send', name: 'Enviar por WhatsApp', args: { to: c.trig.module === 'core' ? '{{trigger.body.telefono}}' : '', text: replyOrMsg(c) } }) },
  { re: /\bsms\b|twilio/, app: 'twilio', build: (c) => ({ module: 'twilio', key: 'sms', name: 'Enviar SMS', args: { to: '', body: msg(c) } }) },
  { re: /gmail/, app: 'gmail', build: (c) => ({ module: 'gmail', key: 'send', name: 'Enviar correo (Gmail)', args: { to: '', subject: c.trig.label, body: msg(c) } }) },
  { re: /correo|email|e-mail|mail\b/, build: (c) => ({ module: 'resend', key: 'send', name: 'Enviar correo', args: { from: '', to: '', subject: `Aviso: ${c.trig.label}`, html: msg(c) } }) },
  { re: /notion/, app: 'notion', build: (c) => ({ module: 'notion', key: 'create-page', name: 'Guardar en Notion', args: { databaseId: '', title: c.trig.text || c.trig.summary, titleProperty: 'Name', content: msg(c) } }) },
  { re: /sheets|hoja de calculo|excel|spreadsheet/, app: 'google-sheets', build: (c) => ({ module: 'google-sheets', key: 'append', name: 'Añadir fila en Google Sheets', args: { spreadsheetId: '', range: 'Hoja1!A1', values: `{{now}} | ${c.trig.text || c.trig.summary}` } }) },
  { re: /airtable/, app: 'airtable', build: (c) => ({ module: 'airtable', key: 'create', name: 'Crear registro en Airtable', args: { baseId: '', table: '', fields: JSON.stringify({ Descripcion: c.trig.summary }, null, 2) } }) },
  { re: /hubspot|crm/, app: 'hubspot', build: () => ({ module: 'hubspot', key: 'contact', name: 'Crear contacto en HubSpot', args: { email: '{{trigger.email}}' } }) },
  { re: /pipedrive/, app: 'pipedrive', build: (c) => ({ module: 'pipedrive', key: 'deal', name: 'Crear trato en Pipedrive', args: { title: c.trig.text || c.trig.summary } }) },
  { re: /salesforce/, app: 'salesforce', build: () => ({ module: 'salesforce', key: 'lead', name: 'Crear lead en Salesforce', args: { lastName: '', company: '', email: '{{trigger.email}}' } }) },
  { re: /zendesk|ticket/, app: 'zendesk', build: (c) => ({ module: 'zendesk', key: 'ticket', name: 'Crear ticket en Zendesk', args: { subject: c.trig.label, body: msg(c) } }) },
  { re: /freshdesk/, app: 'freshdesk', build: (c) => ({ module: 'freshdesk', key: 'ticket', name: 'Crear ticket en Freshdesk', args: { subject: c.trig.label, description: msg(c), email: '' } }) },
  { re: /trello/, app: 'trello', build: (c) => ({ module: 'trello', key: 'card', name: 'Crear tarjeta en Trello', args: { listId: '', name: c.trig.text || c.trig.summary, desc: msg(c) } }) },
  { re: /asana/, app: 'asana', build: (c) => ({ module: 'asana', key: 'task', name: 'Crear tarea en Asana', args: { projectId: '', name: c.trig.text || c.trig.summary, notes: msg(c) } }) },
  { re: /clickup/, app: 'clickup', build: (c) => ({ module: 'clickup', key: 'task', name: 'Crear tarea en ClickUp', args: { listId: '', name: c.trig.text || c.trig.summary, description: msg(c) } }) },
  { re: /jira/, app: 'jira', build: (c) => ({ module: 'jira', key: 'issue', name: 'Crear incidencia en Jira', args: { project: '', summary: c.trig.text || c.trig.summary, description: msg(c), type: 'Task' } }) },
  { re: /linear/, app: 'linear', build: (c) => ({ module: 'linear', key: 'issue', name: 'Crear incidencia en Linear', args: { teamId: '', title: c.trig.text || c.trig.summary, description: msg(c) } }) },
  { re: /todoist|tarea/, app: 'todoist', build: (c) => ({ module: 'todoist', key: 'task', name: 'Crear tarea en Todoist', args: { content: c.trig.text || c.trig.summary, description: msg(c) } }) },
  { re: /calendar|calendario|evento|reunion/, app: 'google-calendar', build: (c) => ({ module: 'google-calendar', key: 'create-event', name: 'Crear evento en Google Calendar', args: { summary: c.trig.label, start: '', end: '', description: msg(c) } }) },
  { re: /notificaci|push|ntfy|avisame al movil|al celular/, build: (c) => ({ module: 'ntfy', key: 'push', name: 'Notificación al móvil', args: { topic: `agent-studio-${randomUUID().slice(0, 8)}`, message: msg(c), title: 'Agent Studio' } }) },
  { re: /mercado ?pago|enlace de pago|link de pago/, app: 'mercadopago', build: () => ({ module: 'mercadopago', key: 'payment-link', name: 'Crear enlace de pago', args: { title: '', price: '', currency: 'MXN' } }) },
];

function replyOrMsg(c: Ctx): string {
  const agent = [...c.prev].reverse().find((s) => s.module === 'agent-studio');
  return agent ? `{{steps.${agent.id}.reply}}` : msg(c);
}

// Acciones mencionadas, en el orden en que aparecen en la frase
function pickActions(t: string, c: Ctx): FlowStep[] {
  const clause = triggerClause(t);
  const rest = clause === t ? t : t.replace(clause, ' ');
  const found: { at: number; rule?: ActionRule; url?: string; cat?: ReturnType<typeof listModules>[number] }[] = [];
  // Las URLs (MCP, OpenAPI, APIs) entran en el orden en que aparecen en la frase
  for (const u of c.urls) found.push({ at: Math.max(0, rest.indexOf(norm(u))), url: u });
  for (const rule of ACTIONS) {
    const m = rest.replace(/https?:\/\/\S+/g, ' ').match(rule.re);
    if (!m) continue;
    // La app del disparador no se repite como acción, salvo para responder por el mismo canal
    if (rule.app && rule.app === c.trig.app && !/respond|contest|devuelve|responde/.test(t)) continue;
    found.push({ at: m.index ?? 0, rule });
  }
  // Apps del catálogo (APIs y MCP) nombradas en la frase: "…y crea un issue en Linear"
  const mods = listModules();
  const nameOf = (k?: string) => normName(mods.find((m) => m.key === k)?.name ?? k ?? '').split(/[\s(]/)[0];
  const covered = new Set([...found.map((f) => nameOf(f.rule?.app)), nameOf(c.trig.module)].filter(Boolean));
  for (const m of catalogMentions(rest)) {
    if (covered.has(normName(m.mod.name).split(/[\s(]/)[0])) continue; // ya lo cubre una app hecha a mano
    found.push({ at: m.at, cat: m.mod });
  }
  // El agente responde antes que cualquier envío; el resto, en el orden de la frase
  const isAgent = (r?: ActionRule) => Boolean(r?.re.source.startsWith('atiend'));
  found.sort((a, b) => Number(isAgent(b.rule)) - Number(isAgent(a.rule)) || a.at - b.at);
  const steps: FlowStep[] = [];
  const seen = new Set<string>();
  for (const { rule, url, cat } of found) {
    if (url) { steps.push(urlStep(url)); continue; }
    if (cat) {
      const act = cat.actions[0];
      if (act && !seen.has(cat.key)) { seen.add(cat.key); steps.push({ id: sid(), module: cat.key, key: act.key, name: `${cat.name}: ${act.name}`, args: {} }); }
      continue;
    }
    const s = rule!.build({ ...c, prev: [...c.prev, ...steps] });
    const key = `${s.module}.${s.key}`;
    if (seen.has(key) && s.module !== 'ia') continue;
    seen.add(key);
    steps.push({ ...s, id: s.id ?? sid(), args: s.args ?? {} } as FlowStep);
  }
  // Bot de Telegram/WhatsApp con agente: responder por el mismo canal
  const agentStep = steps.find((s) => s.module === 'agent-studio');
  if (agentStep && c.trig.module === 'telegram' && !steps.some((s) => s.module === 'telegram')) {
    steps.push({ id: sid(), module: 'telegram', key: 'send', name: 'Responder por Telegram', args: { chatId: '{{trigger.chatId}}', text: `{{steps.${agentStep.id}.reply}}` } });
  }
  return steps;
}

// Apps del catálogo cuyo nombre aparece como palabra en el texto (normalizado)
const normName = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\((mcp|api)\)$/, '');
function catalogMentions(text: string) {
  const out: { at: number; mod: ReturnType<typeof listModules>[number] }[] = [];
  for (const mod of listModules()) {
    if (mod.badge !== 'API' && mod.badge !== 'MCP') continue;
    const n = normName(mod.name);
    if (n.length < 4) continue;
    const m = text.match(new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`));
    if (m) out.push({ at: m.index ?? 0, mod });
  }
  // si una app tiene versión API y MCP, basta una
  const seen = new Set<string>();
  return out.filter((o) => { const k = normName(o.mod.name); if (seen.has(k)) return false; seen.add(k); return true; });
}

function urlStep(url: string): FlowStep {
  if (/openapi|swagger/i.test(url)) return { id: sid(), module: 'openapi', key: 'list-operations', name: 'Ver operaciones de la API', args: { specUrl: url } };
  if (/\/mcp\b|\/sse\b|mcp\./i.test(url)) return { id: sid(), module: 'mcp', key: 'list-tools', name: 'Ver herramientas del servidor MCP', args: { preset: '', url, transport: /\/sse\b/.test(url) ? 'sse' : 'http' } };
  return { id: sid(), module: 'http', key: 'request', name: 'Llamar a la API', args: { method: 'GET', url } };
}

const wantsAgent = (t: string) => /atiend|respond\w* (a|las|los|dudas|preguntas|client)|contest|agend\w* citas|soporte|chatbot|asistente (que|para)|bot que|dudas/.test(t);

// ---------- planificación con LLM (opcional) ----------

async function llmPlan(text: string): Promise<{ trigger: Flow['trigger']; steps: FlowStep[]; name: string } | null> {
  if (!llmConfigured()) return null;
  // Las apps del catálogo (cientos) solo entran si se nombran; el resto de módulos, siempre
  const mentioned = new Set(catalogMentions(normName(text)).map((m) => m.mod.key));
  const catalog = listModules()
    .filter((m) => (m.badge !== 'API' && m.badge !== 'MCP') || mentioned.has(m.key))
    .map((m) => `${m.key}: ${m.name}. Disparadores: ${m.triggers.map((t) => `${t.key} (${t.name})`).join(', ') || '—'}. Acciones: ${m.actions.map((a) => `${a.key} [${(a.arguments ?? []).map((x) => x.key).join(',')}]`).join(', ') || '—'}`)
    .join('\n');
  try {
    const r = await chat(
      [
        { role: 'system', content: 'Diseñas automatizaciones. Devuelve SOLO JSON: {"name": string, "trigger": {"module","key","args"}, "steps": [{"module","key","name","args"}]}. Usa únicamente módulos, disparadores y acciones del catálogo. En args puedes usar {{trigger.campo}} y {{steps.<id>.campo}}, donde <id> es "paso1", "paso2"... según el orden.' },
        { role: 'user', content: `Catálogo:\n${catalog}\n\nPetición: ${text}` },
      ],
      { json: true, temperature: 0, step: 'planificar' },
    );
    const plan = JSON.parse(r.content ?? '{}');
    if (!plan.trigger || !getTrigger(plan.trigger.module, plan.trigger.key)) return null;
    const steps: FlowStep[] = (plan.steps ?? [])
      .filter((s: FlowStep) => getAction(s.module, s.key))
      .map((s: FlowStep, i: number) => ({ id: `paso${i + 1}`, module: s.module, key: s.key, name: s.name || s.key, args: s.args ?? {} }));
    if (!steps.length) return null;
    return { name: String(plan.name || text).slice(0, 80), trigger: { module: plan.trigger.module, key: plan.trigger.key, args: plan.trigger.args ?? {} }, steps };
  } catch {
    return null;
  }
}

// ---------- resumen para el usuario ----------

async function disconnected(flow: Flow): Promise<string[]> {
  const mods = new Map(listModules().map((m) => [m.key, m]));
  const out = new Set<string>();
  for (const s of [...(flow.trigger ? [flow.trigger] : []), ...flow.steps]) {
    const mod = mods.get(s.module);
    if (!mod?.auth) continue;
    const c = await getConnection(mod.key, mod.auth.fields.map((f) => f.key));
    if (mod.auth.fields.some((f) => !f.optional && !c[f.key])) out.add(mod.name);
  }
  return [...out];
}

function describe(flow: Flow): { lines: string[]; missing: string[]; needsConnection: string[] } {
  const mods = new Map(listModules().map((m) => [m.key, m]));
  const lines: string[] = [];
  const t = flow.trigger ? mods.get(flow.trigger.module)?.triggers.find((x) => x.key === flow.trigger!.key) : null;
  // Misma numeración que el editor: 1 = disparador, 2… = acciones
  if (t) lines.push(`1. ⚡ ${t.name} (${mods.get(flow.trigger!.module)?.name})`);
  flow.steps.forEach((s, i) => lines.push(`${i + 2}. ${s.name || s.key} (${mods.get(s.module)?.name ?? s.module})`));
  const missing: string[] = [];
  const needsConnection = new Set<string>();
  for (const s of [...(flow.trigger ? [{ ...flow.trigger, id: 'trigger', name: 'Disparador' }] : []), ...flow.steps] as (FlowStep & { id: string })[]) {
    const mod = mods.get(s.module);
    if (mod?.auth) needsConnection.add(mod.name);
    const def = s.id === 'trigger' ? mod?.triggers.find((x) => x.key === s.key) : mod?.actions.find((x) => x.key === s.key);
    for (const a of def?.arguments ?? []) if (a.required && (s.args?.[a.key] === undefined || s.args?.[a.key] === '')) missing.push(`${s.name || mod?.name}: ${a.label}`);
  }
  return { lines, missing, needsConnection: [...needsConnection] };
}

// Rellena los valores por defecto de cada argumento (p. ej. "comprobar cada 5 minutos")
function withDefaults(flow: Partial<Flow>): Partial<Flow> {
  const mods = new Map(listModules().map((m) => [m.key, m]));
  const fill = (defs: { key: string; default?: unknown }[] = [], args: Record<string, unknown> = {}) => ({
    ...Object.fromEntries(defs.filter((d) => d.default !== undefined).map((d) => [d.key, d.default])),
    ...args,
  });
  if (flow.trigger) flow.trigger.args = fill(mods.get(flow.trigger.module)?.triggers.find((t) => t.key === flow.trigger!.key)?.arguments, flow.trigger.args);
  flow.steps = (flow.steps ?? []).map((s) => ({ ...s, args: fill(mods.get(s.module)?.actions.find((a) => a.key === s.key)?.arguments, s.args) }));
  return flow;
}

// ---------- API pública del asistente ----------

export interface AssistantResult { reply: string; flow: Flow; agent?: { id: string; name: string } | null; created: boolean }

async function createAgentFor(text: string): Promise<AgentDef> {
  // Hasta 7 palabras, sin terminar en preposición o artículo ("…de mi tienda", no "…de mi")
  const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'mi', 'mis', 'tu', 'por', 'a', 'al', 'para', 'con', 'y', 'en', 'un', 'una']);
  const ws = text.replace(/[«»"'.,;:!?¿¡]/g, '').split(/\s+/).filter(Boolean).slice(0, 7);
  while (ws.length > 2 && STOP.has(ws[ws.length - 1].toLowerCase())) ws.pop();
  const words = ws.join(' ');
  const name = words.charAt(0).toUpperCase() + words.slice(1);
  return saveAgent({
    id: await uniqueId(slugify(name)),
    name,
    icon: '✨',
    description: text,
    instructions: `Eres un asistente cuyo objetivo es: ${text}.\nSé amable, breve y claro. Si no sabes algo, dilo y ofrece alternativas.`,
    greeting: '¡Hola! ¿En qué te puedo ayudar hoy?',
    voice: { enabled: true },
  });
}

// Crea un flujo nuevo (y un agente si la petición describe uno) a partir de una frase
export async function planFromText(text: string): Promise<AssistantResult> {
  const t = norm(text);
  const urls = text.match(/https?:\/\/[^\s)"']+/g) ?? [];
  let agent: AgentDef | null = null;
  if (wantsAgent(t)) agent = await createAgentFor(text);

  const viaLlm = await llmPlan(text);
  let flow: Flow;
  if (viaLlm) {
    flow = await saveFlow(withDefaults({ name: viaLlm.name, active: false, trigger: viaLlm.trigger, steps: viaLlm.steps }));
  } else {
    const trig = pickTrigger(t);
    const steps = pickActions(t, { trig, agentId: agent?.id, prev: [], text: t, urls });
    if (!steps.length) steps.push(agent
      ? { id: sid(), module: 'agent-studio', key: 'chat', name: 'Responder con el agente', args: { agentId: agent.id, message: trig.text || '{{trigger.body.mensaje}}' } }
      : { id: sid(), module: 'formato', key: 'template', name: 'Preparar el mensaje', args: { template: trig.summary } });
    const sample = trig.key === 'webhook' ? { body: { nombre: 'Ana', mensaje: 'Hola, ¿qué horarios tienen?', telefono: '5215555555555' } } : trig.key === 'agent-turn' ? { agentId: agent?.id ?? 'soporte-al-cliente', agentName: agent?.name ?? 'Soporte', message: 'quiero hablar con una persona', topic: 'Hablar con una persona' } : undefined;
    flow = await saveFlow(withDefaults({ name: text.length > 70 ? `${text.slice(0, 67)}…` : text, active: false, trigger: { module: trig.module, key: trig.key, args: trig.args }, steps, ...(sample ? { testPayload: sample } : {}) }));
  }
  const d = describe(flow);
  const reply = [
    agent ? `Creé el agente **${agent.name}** y una automatización que lo usa.` : 'Preparé esta automatización:',
    ...d.lines,
    d.needsConnection.length ? `\nPara activarla conecta: ${d.needsConnection.join(', ')}.` : '',
    d.missing.length ? `Me faltan algunos datos: ${d.missing.slice(0, 4).join(' · ')}.` : '',
    '\nPuedes decirme cosas como «añade un aviso por Slack», «quita el paso 2», «cámbialo a cada hora» o «publícalo».',
  ].filter(Boolean).join('\n');
  return { reply, flow, agent: agent ? { id: agent.id, name: agent.name } : null, created: true };
}

// Un mensaje de chat: crea o modifica el flujo en curso
export async function assistantTurn(message: string, flowId?: string): Promise<AssistantResult> {
  const t = norm(message);
  const urls = message.match(/https?:\/\/[^\s)"']+/g) ?? [];
  let flow: Flow | null = null;
  if (flowId) { try { flow = await getFlow(flowId); } catch { flow = null; } }
  const isNew = !flow || /^(crea|crear|nueva|nuevo|hazme|haz|quiero|necesito)\b.*(automatiz|flujo|bot|agente|asistente)|^(cuando|cada vez que)/.test(t);
  if (isNew) return planFromText(message);
  flow = flow!;

  const trigCtx: TriggerPick = (() => {
    const tr = TRIGGERS.find((x) => flow!.trigger && x.pick().module === flow!.trigger.module && x.pick().key === flow!.trigger.key)?.pick();
    return tr ?? { module: flow!.trigger?.module ?? 'core', key: flow!.trigger?.key ?? 'manual', args: {}, summary: '{{trigger}}', text: '', label: 'el disparador' };
  })();
  const agents = await listAgents();
  const agentId = flow.steps.find((s) => s.module === 'agent-studio')?.args?.agentId as string | undefined ?? agents.find((a) => t.includes(norm(a.name)))?.id;
  let reply = '';

  if (/publica|activa|enciende|ponlo en marcha/.test(t)) {
    const d = describe(flow);
    const off = await disconnected(flow);
    if (off.length) reply = `Antes de publicar conecta: ${off.join(', ')} (en cada tarjeta, paso «Elegir conexión»).`;
    else if (d.missing.length) reply = `Antes de publicar completa: ${d.missing.join(' · ')}.`;
    else { flow.active = true; reply = '✅ Publicada. Ya se ejecutará sola.'; }
  } else if (/pausa|desactiva|apaga|deten/.test(t)) {
    flow.active = false;
    reply = '⏸ Pausada.';
  } else if (/(quita|elimina|borra|remove)\b/.test(t)) {
    const n = t.match(/paso (\d+)/);
    const before = flow.steps.length;
    // El paso 1 es el disparador; las acciones empiezan en el 2
    if (n && Number(n[1]) >= 2) flow.steps.splice(Number(n[1]) - 2, 1);
    else if (n) { reply = 'El paso 1 es el disparador: para cambiarlo dime, por ejemplo, «cambia el disparador a cada hora».'; }
    else {
      const mods = listModules();
      const target = mods.find((m) => t.includes(norm(m.name).split(' ')[0]));
      if (target) flow.steps = flow.steps.filter((s) => s.module !== target.key);
    }
    if (!reply) reply = flow.steps.length < before ? 'Listo, quité ese paso.' : 'No encontré ese paso. Dime su número, por ejemplo «quita el paso 2».';
  } else if (/(cambia|pon|usa).{0,25}(disparador|cuando|cada|empiece|inicie)|^cada /.test(t)) {
    const tr = pickTrigger(t.replace(/(cambia|pon|usa) (el )?(disparador )?(a|por)?/, ''));
    flow.trigger = { module: tr.module, key: tr.key, args: tr.args };
    reply = `Cambié el disparador: ahora empieza cuando ${tr.label}.`;
  } else if (/nombre|llamala|llamalo|renombra/.test(t)) {
    const m = message.match(/["«“](.+?)["»”]/) ?? message.match(/(?:llamala|llámala|llamalo|llámalo|nombre)\s+(.+)$/i);
    if (m) { flow.name = m[1].trim(); reply = `Ahora se llama «${flow.name}».`; }
  } else {
    const added = pickActions(t, { trig: trigCtx, agentId, prev: flow.steps, text: t, urls });
    if (added.length) {
      flow.steps.push(...added);
      reply = `Añadí: ${added.map((s) => s.name).join(', ')}.`;
    } else if (/webhook|url/.test(t) && flow.trigger?.key === 'webhook') {
      reply = `Tu URL de webhook es /hooks/${flow.id}. Envía un POST con JSON (cuando el flujo esté publicado).`;
    } else {
      reply = 'No entendí qué cambiar. Prueba con «añade un correo a ventas@…», «avisa por Slack», «conecta https://…/mcp», «quita el paso 2», «cada hora» o «publícalo».';
    }
  }
  flow = await saveFlow(withDefaults(flow) as Flow);
  const d = describe(flow);
  return {
    reply: [reply, '', ...d.lines, d.needsConnection.length && !flow.active ? `\nConexiones necesarias: ${d.needsConnection.join(', ')}.` : ''].filter((x) => x !== undefined).join('\n').trim(),
    flow,
    agent: null,
    created: false,
  };
}

export async function recentFlows() {
  return (await listFlows()).slice(0, 5).map((f) => ({ id: f.id, name: f.name }));
}

