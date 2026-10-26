// Carga y guarda agentes como YAML en agents/<id>/agent.yaml
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { AgentDef } from './types.ts';
import { invalidate } from './knowledge.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const AGENTS_DIR = join(ROOT, 'agents');

export function agentDir(id: string): string {
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw new Error(`id de agente inválido: ${id}`);
  return join(AGENTS_DIR, id);
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'agente'
  );
}

export async function listAgents(): Promise<AgentDef[]> {
  if (!existsSync(AGENTS_DIR)) return [];
  const out: AgentDef[] = [];
  for (const entry of await readdir(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(await getAgent(entry.name));
    } catch (err) {
      console.warn(`[store] ${entry.name}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAgent(id: string): Promise<AgentDef> {
  const raw = await readFile(join(agentDir(id), 'agent.yaml'), 'utf8');
  const agent = YAML.parse(raw) as AgentDef;
  agent.id = id;
  return agent;
}

export async function saveAgent(agent: AgentDef): Promise<AgentDef> {
  if (!agent.name) throw new Error('El agente necesita "name"');
  if (!agent.instructions) throw new Error('El agente necesita "instructions"');
  agent.id = agent.id || slugify(agent.name);
  const dir = agentDir(agent.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'agent.yaml'), YAML.stringify(agent, { lineWidth: 0 }), 'utf8');
  invalidate(agent.id);
  return agent;
}

export async function saveAgentYaml(id: string, yamlText: string): Promise<AgentDef> {
  const agent = YAML.parse(yamlText) as AgentDef;
  agent.id = id;
  return saveAgent(agent);
}

export async function deleteAgent(id: string): Promise<void> {
  await rm(agentDir(id), { recursive: true, force: true });
  invalidate(id);
}

export async function uniqueId(base: string): Promise<string> {
  let id = slugify(base);
  let n = 2;
  while (existsSync(join(AGENTS_DIR, id))) id = `${slugify(base)}-${n++}`;
  return id;
}
