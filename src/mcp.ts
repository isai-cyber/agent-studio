// Servidor MCP: expone los agentes como herramientas para Claude Desktop, Cursor,
// opencode, n8n o cualquier cliente MCP. Se sirve por HTTP en /mcp (public-api.ts)
// y por stdio con `npm run mcp` (mcp-stdio.ts).
//
// Va por empresa: solo se registran las herramientas que permiten los scopes de
// la clave, y cada herramienta lo vuelve a comprobar con can() al ejecutarse.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import YAML from 'yaml';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listAgents, getAgent, saveAgent, uniqueId, ROOT } from './store.ts';
import { handleTurn, resetSession } from './engine.ts';
import type { AgentDef } from './types.ts';
import type { Ctx } from './authz/context.ts';
import { assertCan } from './authz/can.ts';

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const summary = (a: AgentDef) => ({
  id: a.id,
  name: a.name,
  description: a.description ?? '',
  category: a.category ?? {},
  topics: (a.topics ?? []).map((t) => t.name),
});

async function templates(): Promise<AgentDef[]> {
  return (YAML.parse(await readFile(join(ROOT, 'catalog', 'catalog.yaml'), 'utf8')) as { templates: AgentDef[] }).templates;
}

export function createMcpServer(ctx: Ctx): McpServer {
  const tenantId = ctx.tenantId;
  const server = new McpServer({ name: 'agent-studio', version: '0.1.0' });
  // Registra la herramienta solo si la clave tiene el permiso, y lo revisa al llamarla
  const tool = ((name: string, perm: string, def: unknown, run: (args: any) => Promise<any>) => {
    if (!ctx.permissions.has(perm)) return;
    (server.registerTool as any)(name, def, async (args: unknown) => {
      await assertCan(ctx, { permission: perm });
      return run(args);
    });
  });

  tool(
    'list_agents',
    'agents.read',
    { title: 'Listar agentes', description: 'Lista los agentes disponibles en Agent Studio con su id, descripción y temas.', inputSchema: {} },
    async () => text((await listAgents(tenantId)).map(summary)),
  );

  tool(
    'get_agent',
    'agents.read',
    {
      title: 'Ver agente',
      description: 'Devuelve la definición completa de un agente: instrucciones, temas, conocimiento y acciones.',
      inputSchema: { agent_id: z.string().describe('id del agente (de list_agents)') },
    },
    async ({ agent_id }) => text(await getAgent(tenantId, agent_id)),
  );

  tool(
    'chat_with_agent',
    'agents.read',
    {
      title: 'Hablar con un agente',
      description:
        'Envía un mensaje a un agente y devuelve su respuesta. Para continuar la misma conversación, pasa el session_id devuelto en la respuesta anterior.',
      inputSchema: {
        agent_id: z.string().describe('id del agente'),
        message: z.string().describe('mensaje del usuario'),
        session_id: z.string().optional().describe('id de sesión para continuar una conversación'),
      },
    },
    async ({ agent_id, message, session_id }) => {
      const r = await handleTurn(await getAgent(tenantId, agent_id), session_id, message, 'mcp');
      return text({ session_id: r.sessionId, reply: r.messages.join('\n\n'), options: r.options ?? [], topic: r.topic ?? null });
    },
  );

  tool(
    'create_agent',
    'agents.manage',
    {
      title: 'Crear agente',
      description: 'Crea un agente nuevo a partir de un nombre y unas instrucciones.',
      inputSchema: {
        name: z.string().describe('nombre del agente'),
        instructions: z.string().describe('qué hace el agente y cómo debe comportarse'),
        description: z.string().optional(),
        greeting: z.string().optional().describe('primer mensaje del agente'),
      },
    },
    async ({ name, instructions, description, greeting }) => {
      const agent = await saveAgent(tenantId, { id: await uniqueId(tenantId, name), name, instructions, description, greeting, icon: '✨', voice: { enabled: true } });
      return text(summary(agent));
    },
  );

  tool(
    'list_templates',
    'agents.read',
    { title: 'Listar plantillas', description: 'Lista las plantillas de la biblioteca de escenarios (por función e industria).', inputSchema: {} },
    async () => text((await templates()).map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category }))),
  );

  tool(
    'create_agent_from_template',
    'agents.manage',
    {
      title: 'Crear agente desde plantilla',
      description: 'Crea un agente copiando una plantilla de la biblioteca.',
      inputSchema: { template_id: z.string().describe('id de la plantilla (de list_templates)') },
    },
    async ({ template_id }) => {
      const tpl = (await templates()).find((t) => t.id === template_id);
      if (!tpl) return { ...text(`Plantilla no encontrada: ${template_id}`), isError: true };
      const agent = await saveAgent(tenantId, { ...structuredClone(tpl), id: await uniqueId(tenantId, tpl.id), source: 'template' });
      return text(summary(agent));
    },
  );

  tool(
    'reset_conversation',
    'agents.read',
    {
      title: 'Reiniciar conversación',
      description: 'Olvida el historial de una sesión de chat.',
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => {
      resetSession(tenantId, session_id);
      return text('Conversación reiniciada');
    },
  );

  return server;
}
