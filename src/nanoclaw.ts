// Backend NanoClaw: los agentes de Agent Studio se ejecutan como "agent groups"
// de NanoClaw (cada uno en su contenedor), con el proveedor opencode → DeepSeek.
//
// Se habla con NanoClaw por su canal "local-web" (http://127.0.0.1:3210):
//   POST /api/agents    crea el agente y su conversación
//   POST /api/messages  envía un mensaje
//   GET  /events        stream SSE con las respuestas
// Las instrucciones del agente se escriben en groups/<carpeta>/CLAUDE.md.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDef, Step } from './types.ts';
import { agentDir } from './store.ts';

export const BACKEND = (process.env.AGENT_BACKEND ?? 'direct').toLowerCase(); // direct | nanoclaw
const DIR = (process.env.NANOCLAW_DIR ?? join(homedir(), 'nanoclaw')).replace(/^~/, homedir());
const URL_BASE = (process.env.NANOCLAW_URL ?? 'http://127.0.0.1:3210').replace(/\/$/, '');
const PROVIDER = process.env.NANOCLAW_PROVIDER ?? 'opencode';
const MODEL = process.env.NANOCLAW_MODEL ?? 'deepseek/deepseek-chat';
const REPLY_TIMEOUT_MS = Number(process.env.NANOCLAW_REPLY_TIMEOUT_MS ?? 180_000);

export function useNanoclaw(): boolean {
  return BACKEND === 'nanoclaw';
}

async function token(): Promise<string> {
  const file = join(DIR, 'data', 'local-web', 'token');
  if (!existsSync(file)) throw new Error(`No se encontró el token de NanoClaw en ${file}. ¿Está instalado el canal local-web?`);
  return (await readFile(file, 'utf8')).trim();
}

async function headers(): Promise<Record<string, string>> {
  return {
    'x-nanoclaw-local-web-token': await token(),
    // local-web solo acepta peticiones del mismo origen
    Origin: URL_BASE,
    'Content-Type': 'application/json',
  };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${URL_BASE}${path}`, { ...init, headers: { ...(await headers()), ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`NanoClaw ${res.status}: ${body.error ?? res.statusText}`);
  return body;
}

export interface NanoclawStatus {
  reachable: boolean;
  installedProviders?: string[];
  providerReady?: boolean;
  provider: string;
  model: string;
  error?: string;
}

export async function status(): Promise<NanoclawStatus> {
  const base = { provider: PROVIDER, model: MODEL };
  try {
    const health = await fetch(`${URL_BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) return { ...base, reachable: false, error: `healthz ${health.status}` };
    const catalog = await api<{ installedProviders: string[] }>('/api/conversations');
    const installed = ['claude', ...catalog.installedProviders.filter((p) => p !== 'claude')];
    return { ...base, reachable: true, installedProviders: installed, providerReady: installed.includes(PROVIDER) };
  } catch (err) {
    return { ...base, reachable: false, error: (err as Error).message };
  }
}

// Misma regla que NanoClaw (folderForAgentName) para saber dónde escribir CLAUDE.md
export function folderFor(name: string): string {
  const normalized = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed').slice(0, 59).replace(/[-_]+$/, '');
  return `web-${normalized}`;
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
        case 'action': return `${pad}- Ejecuta la acción **${s.action}**${s.saveAs ? ` y guarda el resultado como \`${s.saveAs}\`` : ''}`;
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
    if (k.type === 'url' && k.url) parts.push(`### ${k.name ?? k.url}\n\nConsulta ${k.url} con tu herramienta web cuando la pregunta trate de este tema.`);
    if (k.type === 'file' && k.path) {
      try {
        const text = await readFile(join(agentDir(agent.id), k.path), 'utf8');
        parts.push(`### ${k.name ?? k.path}\n\n${text.slice(0, 30_000).trim()}`);
      } catch {}
    }
  }
  return parts.join('\n\n');
}

export async function buildClaudeMd(agent: AgentDef): Promise<string> {
  const sections = [
    `<!-- Generado por Agent Studio a partir de agents/${agent.id}/agent.yaml. Edítalo allí: se sobrescribe al sincronizar. -->`,
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
    sections.push(
      `## Acciones disponibles\n\n` +
        agent.actions
          .map((a) => `- **${a.name}**: ${a.description}. \`${a.method ?? 'POST'} ${a.url}\`${a.parameters ? ` — parámetros: ${Object.keys(a.parameters.properties).join(', ')}` : ''}`)
          .join('\n'),
    );
  }
  return sections.filter(Boolean).join('\n\n') + '\n';
}

// ---------- sincronizar y conversar ----------

export interface NanoclawLink {
  conversationId: string;
  folder: string;
  provider: string;
  model: string;
  syncedAt: string;
}

export async function syncAgent(agent: AgentDef): Promise<NanoclawLink> {
  const res = await api<{ conversation: { conversationId: string } }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({ name: agent.name.slice(0, 64), provider: PROVIDER, model: MODEL }),
  });
  const folder = folderFor(agent.name.slice(0, 64));
  const groupDir = join(DIR, 'groups', folder);
  if (!existsSync(groupDir)) throw new Error(`NanoClaw creó el agente pero no existe ${groupDir}`);
  await writeFile(join(groupDir, 'CLAUDE.md'), await buildClaudeMd(agent), 'utf8');
  return { conversationId: res.conversation.conversationId, folder, provider: PROVIDER, model: MODEL, syncedAt: new Date().toISOString() };
}

export interface NanoclawReply {
  text: string;
  options?: string[];
}

// Envía un mensaje y espera la respuesta por SSE. NanoClaw puede mandar varias
// respuestas seguidas, así que tras la primera se espera un poco por si llegan más.
export async function send(conversationId: string, text: string): Promise<NanoclawReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REPLY_TIMEOUT_MS);
  try {
    const res = await fetch(`${URL_BASE}/events?conversationId=${encodeURIComponent(conversationId)}`, {
      headers: await headers(),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`NanoClaw /events ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let posted = false;
    const replies: string[] = [];
    let options: string[] | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const settled = new Promise<void>((resolve) => {
      ctrl.signal.addEventListener('abort', () => resolve());
    });

    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as { type: string; text?: string; question?: string; title?: string; options?: { label: string }[] };
          if (event.type === 'ready' && !posted) {
            posted = true;
            await api('/api/messages', { method: 'POST', body: JSON.stringify({ conversationId, text }) });
          } else if (posted && event.type === 'reply' && event.text) {
            replies.push(event.text);
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => ctrl.abort(), 2500);
          } else if (posted && event.type === 'question') {
            options = event.options?.map((o) => o.label);
            const q = event.question || event.title;
            if (q) replies.push(q);
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => ctrl.abort(), 1000);
          }
        }
      }
    })().catch((err) => {
      if (!ctrl.signal.aborted) throw err;
    });

    await Promise.race([pump, settled]);
    clearTimeout(settleTimer);
    if (!replies.length) throw new Error('NanoClaw no respondió a tiempo (¿Docker arrancado y proveedor configurado?)');
    return { text: replies.join('\n\n'), options };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}
