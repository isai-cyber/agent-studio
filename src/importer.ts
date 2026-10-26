// Importa agentes exportados desde Copilot Studio (Solution .zip de Power Platform)
// o temas sueltos copiados del "editor de código" de un tema (YAML AdaptiveDialog).
//
// Estructura típica de una solución exportada:
//   bots/<schema>/bot.xml, bots/<schema>/configuration.json
//   botcomponents/<schema>/botcomponent.xml   (nombre, tipo, bot padre)
//   botcomponents/<schema>/data               (YAML: temas, instrucciones, conocimiento)
//   botcomponents/<schema>/filedata/...       (archivos subidos como conocimiento)
//
// La conversión es "best effort": Power Fx y nodos avanzados se traducen a lo más
// parecido que soporta este motor, y lo que no se puede traducir se marca con
// un mensaje "[IMPORT] ..." para revisarlo a mano en el editor.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, stat, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import YAML from 'yaml';
import type { ActionDef, AgentDef, KnowledgeSource, Step, Topic } from './types.ts';
import { agentDir, saveAgent, uniqueId } from './store.ts';

const run = promisify(execFile);

type Y = Record<string, any>;

export interface ImportReport {
  agents: { id: string; name: string; topics: number; knowledge: number; actions: number }[];
  warnings: string[];
}

// ---------- Power Fx → expresiones del motor ----------

function varName(v: string): string {
  // init:Topic.Ciudad / Topic.Ciudad / Global.X / System.User.DisplayName
  return v
    .replace(/^init:/, '')
    .replace(/^(Topic|Global|Bot)\./, '')
    .replace(/^System\.User\.DisplayName$/, 'userName')
    .replace(/^System\.Bot\.Name$/, 'botName')
    .replace(/^System\.Activity\.Text$/, 'lastMessage');
}

function fxToCondition(fx: string): string {
  let s = String(fx).trim().replace(/^=/, '');
  s = s.replace(/\b(?:Topic|Global|Bot)\.(\w+)/g, '$1');
  s = s.replace(/<>/g, ' != ');
  s = s.replace(/(?<![=!<>])=(?!=)/g, ' == ');
  s = s.replace(/&&|\bAnd\b/g, ' and ').replace(/\|\||\bOr\b/g, ' or ');
  s = s.replace(/IsBlank\((\w+)\)/gi, '!$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function fxText(t: unknown): string {
  // Plantillas de mensaje: "Hola {Topic.Nombre}" → "Hola {{Nombre}}"
  if (t === null || t === undefined) return '';
  let s = String(t);
  if (s.startsWith('=')) s = s.slice(1).replace(/^"|"$/g, '');
  return s.replace(/\{([A-Za-z][\w.]*)\}/g, (_, v: string) => `{{${varName(v)}}}`);
}

function activityText(activity: unknown): string {
  if (typeof activity === 'string') return fxText(activity);
  if (activity && typeof activity === 'object') {
    const a = activity as Y;
    if (Array.isArray(a.text)) return fxText(a.text[0]);
    if (a.text) return fxText(a.text);
    if (Array.isArray(a.speak)) return fxText(a.speak[0]);
    if (a.attachments) return '[IMPORT] Tarjeta adaptativa: revisar y convertir a texto';
  }
  return '';
}

// ---------- nodos de un tema ----------

function convertActions(nodes: Y[] | undefined, warnings: string[], ctx: string): Step[] {
  const steps: Step[] = [];
  for (const n of nodes ?? []) {
    switch (n.kind) {
      case 'SendActivity':
      case 'SendMessage':
        steps.push({ type: 'message', text: activityText(n.activity ?? n.message) });
        break;
      case 'Question': {
        // entity puede ser un objeto con lista cerrada o un nombre de entidad
        // predefinida (p. ej. "BooleanPrebuiltEntity")
        const rawItems = typeof n.entity === 'object' ? (n.entity?.definition?.items ?? n.entity?.items) : undefined;
        const items: Y[] = Array.isArray(rawItems) ? rawItems : [];
        let options = items.map((i) => String(i.displayName ?? i.id)).filter(Boolean);
        if (!options.length && /Boolean/i.test(String(n.entity?.kind ?? n.entity ?? ''))) options = ['Sí', 'No'];
        steps.push({
          type: 'question',
          prompt: activityText(n.prompt),
          variable: varName(String(n.variable ?? 'respuesta')),
          ...(options.length ? { options } : {}),
        });
        break;
      }
      case 'ConditionGroup': {
        // if / else-if / else  →  condiciones anidadas
        const conds: Y[] = n.conditions ?? [];
        let tail: Step[] = convertActions(n.elseActions, warnings, ctx);
        for (let i = conds.length - 1; i >= 0; i--) {
          tail = [{ type: 'condition', if: fxToCondition(conds[i].condition), then: convertActions(conds[i].actions, warnings, ctx), else: tail }];
        }
        steps.push(...tail);
        break;
      }
      case 'SetVariable':
      case 'SetTextVariable':
        steps.push({ type: 'set', variable: varName(String(n.variable)), value: fxText(n.value) });
        break;
      case 'SearchAndSummarizeContent':
      case 'AnswerQuestionWithAI':
      case 'CreateSearchQuery':
        steps.push({ type: 'generate', useKnowledge: true });
        break;
      case 'BeginDialog':
      case 'ReplaceDialog':
        steps.push({ type: 'goto', topic: String(n.dialog ?? '').split('.').pop() ?? '' });
        break;
      case 'EndDialog':
      case 'EndConversation':
      case 'CancelAllDialogs':
        steps.push({ type: 'end' });
        break;
      case 'InvokeFlowAction':
      case 'InvokeConnectorAction':
      case 'InvokeAIBuilderModelAction':
      case 'HttpRequestAction': {
        const name = String(n.flowId ?? n.connectionReference ?? n.operationId ?? n.url ?? n.kind);
        warnings.push(`${ctx}: acción "${n.kind}" (${name}) necesita reconfigurarse como acción HTTP.`);
        steps.push({
          type: 'action',
          action: name,
          inputs: Object.fromEntries(Object.entries((n.input?.binding ?? {}) as Y).map(([k, v]) => [k, fxText(v)])),
          saveAs: n.output?.binding ? Object.values(n.output.binding as Y).map((v) => varName(String(v)))[0] : undefined,
        });
        break;
      }
      default:
        if (n.kind) {
          warnings.push(`${ctx}: nodo "${n.kind}" no soportado, se dejó una nota.`);
          steps.push({ type: 'message', text: `[IMPORT] Nodo ${n.kind} sin equivalente; revisar.` });
        }
    }
  }
  return steps;
}

export function convertTopic(data: Y, fallbackName: string, warnings: string[]): Topic | undefined {
  const begin: Y = data.beginDialog ?? data;
  const kind = String(begin.kind ?? '');
  const name = String(begin.intent?.displayName ?? data.displayName ?? fallbackName);
  const triggers: string[] = (begin.intent?.triggerQueries ?? []).map(String);
  if (kind === 'OnConversationStart') {
    return { name: 'Saludo', description: 'Inicio de conversación', triggers: [], steps: convertActions(begin.actions, warnings, name) };
  }
  if (kind === 'OnSelectIntent' || kind === 'OnUnknownIntent' || kind === 'OnError' || kind === 'OnEscalate' || kind === 'OnSignIn' || kind === 'OnSystemRedirect') {
    if (kind === 'OnEscalate') {
      return { name, description: 'Escalar con un humano', triggers: triggers.length ? triggers : ['hablar con una persona', 'agente humano'], steps: convertActions(begin.actions, warnings, name) };
    }
    return undefined; // el motor ya tiene respuesta generativa y manejo de errores
  }
  const steps = convertActions(begin.actions, warnings, name);
  if (!steps.length && !triggers.length) return undefined;
  return { name, description: begin.intent?.description ?? data.modelDescription, triggers, steps };
}

// ---------- lectura de la solución ----------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

function xmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m?.[1]?.trim();
}

interface RawComponent {
  schema: string;
  name: string;
  description?: string;
  parentBot?: string;
  data?: Y;
  dataRaw?: string;
  files: string[];
}

async function readSolutionDir(root: string): Promise<{ bots: Map<string, { name: string; config?: Y }>; components: RawComponent[] }> {
  const bots = new Map<string, { name: string; config?: Y }>();
  const components: RawComponent[] = [];

  const botsDir = join(root, 'bots');
  if (existsSync(botsDir)) {
    for (const schema of await readdir(botsDir)) {
      const d = join(botsDir, schema);
      if (!(await stat(d)).isDirectory()) continue;
      const xml = existsSync(join(d, 'bot.xml')) ? await readFile(join(d, 'bot.xml'), 'utf8') : '';
      let config: Y | undefined;
      try {
        config = JSON.parse(await readFile(join(d, 'configuration.json'), 'utf8'));
      } catch {}
      bots.set(schema, { name: xmlTag(xml, 'name') ?? schema, config });
    }
  }

  const compDir = join(root, 'botcomponents');
  if (existsSync(compDir)) {
    for (const schema of await readdir(compDir)) {
      const d = join(compDir, schema);
      if (!(await stat(d)).isDirectory()) continue;
      const xml = existsSync(join(d, 'botcomponent.xml')) ? await readFile(join(d, 'botcomponent.xml'), 'utf8') : '';
      const parentBlock = xmlTag(xml, 'parentbotid') ?? '';
      const parentBot = xmlTag(parentBlock, 'schemaname') ?? (parentBlock.replace(/<[^>]+>/g, '').trim() || undefined);
      let dataRaw: string | undefined;
      let data: Y | undefined;
      if (existsSync(join(d, 'data'))) {
        dataRaw = await readFile(join(d, 'data'), 'utf8');
        try {
          data = YAML.parse(dataRaw);
        } catch {}
      }
      const files = existsSync(join(d, 'filedata')) ? await walk(join(d, 'filedata')) : [];
      components.push({ schema, name: xmlTag(xml, 'name') ?? schema, description: xmlTag(xml, 'description'), parentBot, data, dataRaw, files });
    }
  }
  return { bots, components };
}

function belongsTo(c: RawComponent, botSchema: string): boolean {
  if (c.parentBot) return c.parentBot === botSchema || c.parentBot.includes(botSchema);
  return c.schema.startsWith(`${botSchema}.`);
}

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml']);

async function buildAgent(botSchema: string, botName: string, comps: RawComponent[], _config: Y | undefined, warnings: string[]): Promise<AgentDef> {
  const id = await uniqueId(botName);
  const dir = agentDir(id);
  await mkdir(join(dir, 'knowledge'), { recursive: true });
  await mkdir(join(dir, 'import'), { recursive: true });

  const topics: Topic[] = [];
  const knowledge: KnowledgeSource[] = [];
  const actions: ActionDef[] = [];
  let instructions = '';
  let description = '';

  for (const c of comps) {
    if (c.dataRaw) await writeFile(join(dir, 'import', `${c.schema.replace(/[^\w.-]/g, '_')}.yaml`), c.dataRaw, 'utf8');
    const kind = String(c.data?.kind ?? '');
    if (kind === 'GptComponentMetadata') {
      instructions = String(c.data?.instructions ?? instructions);
      description = String(c.data?.description ?? c.description ?? c.data?.displayName ?? description);
      continue;
    }
    if (kind === 'KnowledgeSourceConfiguration' || c.data?.source) {
      const src: Y = c.data?.source ?? {};
      const url = src.site ?? src.url ?? src.siteUrl;
      if (url) knowledge.push({ type: 'url', name: c.name, url: String(url) });
      else warnings.push(`${botName}: fuente de conocimiento "${c.name}" (${src.kind ?? 'desconocida'}) no se puede importar automáticamente (SharePoint/Dataverse requieren conector).`);
      continue;
    }
    if (c.files.length) {
      for (const f of c.files) {
        const target = join(dir, 'knowledge', basename(f));
        await copyFile(f, target);
        if (TEXT_EXT.has(extname(f).toLowerCase())) knowledge.push({ type: 'file', name: c.name, path: `knowledge/${basename(f)}` });
        else warnings.push(`${botName}: archivo "${basename(f)}" copiado a knowledge/, pero hay que convertirlo a texto (PDF/DOCX) para indexarlo.`);
      }
      continue;
    }
    if (kind === 'TaskDialog' || kind === 'Action') {
      actions.push({
        name: c.name,
        description: String(c.data?.modelDescription ?? c.data?.description ?? c.name),
        method: 'POST',
        url: 'https://example.com/CONFIGURAR',
      });
      warnings.push(`${botName}: acción "${c.name}" importada como plantilla; configura su URL real.`);
      continue;
    }
    if (kind === 'AdaptiveDialog' || c.data?.beginDialog) {
      const t = convertTopic(c.data!, c.name, warnings);
      if (t) topics.push(t);
    }
  }

  if (!instructions) {
    instructions = `Eres ${botName}, un asistente útil. Responde con información de tu base de conocimiento y, si no sabes algo, dilo.`;
  }

  const agent: AgentDef = {
    id,
    name: botName,
    description: description || `Importado de Copilot Studio (${botSchema})`,
    icon: '🤖',
    language: 'español',
    instructions,
    topics,
    knowledge,
    actions,
    voice: { enabled: true },
    source: 'copilot-studio-import',
  };
  await saveAgent(agent);
  return agent;
}

export async function importPath(input: string): Promise<ImportReport> {
  const warnings: string[] = [];
  const report: ImportReport = { agents: [], warnings };
  let root = input;
  let tmp: string | undefined;

  const info = await stat(input);
  if (info.isFile() && /\.(ya?ml|txt)$/i.test(input)) {
    return importTopicYaml(await readFile(input, 'utf8'), basename(input, extname(input)));
  }
  if (info.isFile()) {
    tmp = await mkdtemp(join(tmpdir(), 'cs-import-'));
    await run('unzip', ['-q', '-o', input, '-d', tmp]);
    root = tmp;
  }

  try {
    // Algunas exportaciones anidan la solución en una subcarpeta
    if (!existsSync(join(root, 'bots')) && !existsSync(join(root, 'botcomponents'))) {
      for (const e of await readdir(root, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(join(root, e.name, 'botcomponents'))) root = join(root, e.name);
      }
    }
    const { bots, components } = await readSolutionDir(root);
    if (!bots.size && !components.length) throw new Error('No se encontraron carpetas bots/ ni botcomponents/ en la solución.');
    if (!bots.size) bots.set('agente', { name: 'Agente importado' });

    for (const [schema, bot] of bots) {
      const comps = bots.size === 1 ? components : components.filter((c) => belongsTo(c, schema));
      const agent = await buildAgent(schema, bot.name, comps, bot.config, warnings);
      report.agents.push({ id: agent.id, name: agent.name, topics: agent.topics?.length ?? 0, knowledge: agent.knowledge?.length ?? 0, actions: agent.actions?.length ?? 0 });
    }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
  return report;
}

// Tema suelto pegado desde el editor de código de Copilot Studio
export async function importTopicYaml(yamlText: string, agentName = 'Agente importado', targetAgentId?: string): Promise<ImportReport> {
  const warnings: string[] = [];
  const docs = YAML.parseAllDocuments(yamlText).map((d) => d.toJSON() as Y).filter(Boolean);
  const topics = docs.map((d, i) => convertTopic(d, `Tema ${i + 1}`, warnings)).filter((t): t is Topic => Boolean(t));
  if (!topics.length) throw new Error('No se reconoció ningún tema (se esperaba YAML con kind: AdaptiveDialog).');

  const { getAgent } = await import('./store.ts');
  let agent: AgentDef;
  if (targetAgentId) {
    agent = await getAgent(targetAgentId);
    agent.topics = [...(agent.topics ?? []).filter((t) => !topics.some((n) => n.name === t.name)), ...topics];
  } else {
    agent = {
      id: await uniqueId(agentName),
      name: agentName,
      instructions: `Eres ${agentName}, un asistente útil.`,
      topics,
      voice: { enabled: true },
      source: 'copilot-studio-import',
    };
  }
  await saveAgent(agent);
  return { agents: [{ id: agent.id, name: agent.name, topics: agent.topics?.length ?? 0, knowledge: agent.knowledge?.length ?? 0, actions: agent.actions?.length ?? 0 }], warnings };
}
