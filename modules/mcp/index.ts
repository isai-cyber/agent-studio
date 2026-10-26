// Módulo MCP: usa cualquier servidor MCP como paso de un flujo. Abre miles de apps:
// los servidores oficiales de Notion, Linear, Stripe, GitHub, Sentry… o pasarelas como
// Zapier MCP o Composio. Muchos servidores remotos piden OAuth o un token: ponlo en las
// cabeceras (p. ej. {"Authorization": "Bearer {{env.FLOW_MI_TOKEN}}"}).
import type { ModuleDef } from '../../src/modules/sdk.ts';
import { callTool, listTools, type McpServerConfig } from '../../src/mcp-client.ts';

const PRESETS = [
  { label: 'Personalizado', value: '' },
  { label: 'DeepWiki (documentación de repos de GitHub, sin clave)', value: 'https://mcp.deepwiki.com/mcp' },
  { label: 'Context7 (documentación de librerías, sin clave)', value: 'https://mcp.context7.com/mcp' },
  { label: 'Hugging Face', value: 'https://huggingface.co/mcp' },
  { label: 'Notion (OAuth)', value: 'https://mcp.notion.com/mcp' },
  { label: 'Linear (OAuth)', value: 'https://mcp.linear.app/mcp' },
  { label: 'GitHub (token)', value: 'https://api.githubcopilot.com/mcp/' },
  { label: 'Sentry (OAuth)', value: 'https://mcp.sentry.dev/mcp' },
  { label: 'Stripe (token)', value: 'https://mcp.stripe.com' },
];

const SERVER_ARGS = [
  { key: 'preset', label: 'Servidor conocido', type: 'dropdown' as const, default: '', options: PRESETS, description: 'O elige "Personalizado" y escribe la URL abajo. Verifica en la documentación de cada proveedor qué autenticación pide.' },
  { key: 'url', label: 'URL del servidor MCP (HTTP)', type: 'string' as const, variables: true, placeholder: 'https://…/mcp' },
  { key: 'headers', label: 'Cabeceras (JSON)', type: 'json' as const, variables: true, placeholder: '{ "Authorization": "Bearer {{env.FLOW_MI_TOKEN}}" }' },
  { key: 'transport', label: 'Transporte', type: 'dropdown' as const, default: 'http', options: [{ label: 'HTTP (Streamable)', value: 'http' }, { label: 'SSE (antiguo)', value: 'sse' }, { label: 'Local (stdio)', value: 'stdio' }] },
  { key: 'command', label: 'Comando local (solo stdio)', type: 'string' as const, placeholder: 'npx', description: 'Ejecuta un programa en el servidor: úsalo solo con paquetes de confianza.' },
  { key: 'args', label: 'Argumentos (solo stdio, separados por espacio)', type: 'string' as const, placeholder: '-y @modelcontextprotocol/server-filesystem /tmp' },
];

function config(a: Record<string, any>, tenantId: number): McpServerConfig {
  let headers: Record<string, string> = {};
  if (a.headers) headers = typeof a.headers === 'string' ? JSON.parse(a.headers) : a.headers;
  return {
    transport: a.transport || 'http',
    url: a.url || a.preset || undefined,
    headers,
    command: a.command || undefined,
    args: a.args ? String(a.args).split(/\s+/).filter(Boolean) : [],
    tenantId,
  };
}

export default {
  key: 'mcp',
  name: 'MCP (cualquier servidor)',
  description: 'Conecta con cualquier servidor MCP y llama a sus herramientas: Notion, Linear, GitHub, Stripe, Zapier MCP y miles más.',
  icon: '🔌',
  color: '#111827',
  category: 'Conectores universales',
  author: 'Agent Studio',
  version: '1.0.0',
  homepage: 'https://modelcontextprotocol.io',
  actions: [
    {
      key: 'list-tools', name: 'Ver herramientas del servidor', description: 'Lista las herramientas y sus parámetros. Úsalo para saber qué nombre poner en "Llamar herramienta".',
      arguments: SERVER_ARGS,
      async run(ctx) {
        const tools = await listTools(config(ctx.args, ctx.tenant.id), false);
        return { total: tools.length, herramientas: tools.map((t) => ({ nombre: t.name, descripcion: t.description, parametros: Object.keys((t.inputSchema?.properties as object) ?? {}) })) };
      },
    },
    {
      key: 'call-tool', name: 'Llamar herramienta', description: 'Resultado en {{steps.<id>.text}} (y {{steps.<id>.structured}} si el servidor lo devuelve).',
      arguments: [
        ...SERVER_ARGS,
        { key: 'tool', label: 'Herramienta', type: 'string', required: true, placeholder: 'read_wiki_structure' },
        { key: 'arguments', label: 'Parámetros (JSON)', type: 'json', variables: true, default: '{}' },
      ],
      async run(ctx) {
        const args = typeof ctx.args.arguments === 'string' ? JSON.parse(ctx.args.arguments || '{}') : (ctx.args.arguments ?? {});
        const r = await callTool(config(ctx.args, ctx.tenant.id), String(ctx.args.tool), args);
        if (r.isError) throw new Error(`La herramienta devolvió un error: ${r.text.slice(0, 300)}`);
        return r;
      },
    },
  ],
} satisfies ModuleDef;
