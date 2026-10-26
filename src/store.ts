// Carga y guarda agentes como YAML en agents/<tenant_id>/<id>/agent.yaml.
// Todas las funciones reciben la empresa: no hay forma de leer agentes de otra.
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { AgentDef } from './types.ts';
import { invalidate } from './knowledge.ts';
import { tenantAgentsPath } from './tenancy/paths.ts';

export { ROOT } from './root.ts';

const notFound = (id: string) => Object.assign(new Error(`Agente no encontrado: ${id}`), { status: 404 });

export function agentDir(tenantId: number, id: string): string {
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw Object.assign(new Error(`id de agente inválido: ${id}`), { status: 400 });
  return tenantAgentsPath(tenantId, id);
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'agente'
  );
}

export async function listAgents(tenantId: number): Promise<AgentDef[]> {
  const base = tenantAgentsPath(tenantId);
  if (!existsSync(base)) return [];
  const out: AgentDef[] = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(await getAgent(tenantId, entry.name));
    } catch (err) {
      console.warn(`[store] ${tenantId}/${entry.name}:`, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAgent(tenantId: number, id: string): Promise<AgentDef> {
  const file = join(agentDir(tenantId, id), 'agent.yaml');
  if (!existsSync(file)) throw notFound(id);
  const agent = YAML.parse(await readFile(file, 'utf8')) as AgentDef;
  agent.id = id;
  // La empresa va pegada al objeto en memoria (no se guarda en el YAML)
  Object.defineProperty(agent, 'tenantId', { value: tenantId, enumerable: false, writable: false });
  return agent;
}

export async function saveAgent(tenantId: number, agent: AgentDef): Promise<AgentDef> {
  if (!agent.name) throw Object.assign(new Error('El agente necesita "name"'), { status: 400 });
  if (!agent.instructions) throw Object.assign(new Error('El agente necesita "instructions"'), { status: 400 });
  if (agent.tenantId !== undefined && agent.tenantId !== tenantId) throw Object.assign(new Error('El agente pertenece a otra empresa'), { status: 403 });
  agent.id = agent.id || slugify(agent.name);
  const dir = agentDir(tenantId, agent.id);
  await mkdir(dir, { recursive: true });
  const { tenantId: _t, ...plain } = agent;
  await writeFile(join(dir, 'agent.yaml'), YAML.stringify(plain, { lineWidth: 0 }), 'utf8');
  invalidate(tenantId, agent.id);
  if (agent.tenantId === undefined) Object.defineProperty(agent, 'tenantId', { value: tenantId, enumerable: false, writable: false });
  return agent;
}

export async function saveAgentYaml(tenantId: number, id: string, yamlText: string): Promise<AgentDef> {
  const agent = YAML.parse(yamlText) as AgentDef;
  if (!agent || typeof agent !== 'object') throw Object.assign(new Error('YAML no válido'), { status: 400 });
  delete (agent as Partial<AgentDef>).tenantId;
  agent.id = id;
  return saveAgent(tenantId, agent);
}

export async function deleteAgent(tenantId: number, id: string): Promise<void> {
  await rm(agentDir(tenantId, id), { recursive: true, force: true });
  invalidate(tenantId, id);
}

export async function countAgents(tenantId: number): Promise<number> {
  const base = tenantAgentsPath(tenantId);
  if (!existsSync(base)) return 0;
  return (await readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).length;
}

export async function uniqueId(tenantId: number, base: string): Promise<string> {
  let id = slugify(base);
  let n = 2;
  while (existsSync(agentDir(tenantId, id))) id = `${slugify(base)}-${n++}`;
  return id;
}
