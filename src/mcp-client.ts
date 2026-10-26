// Cliente MCP: conecta con cualquier servidor MCP (remoto por HTTP/SSE o local por stdio)
// para listar y llamar a sus herramientas. Lo usan el módulo "MCP" de los flujos y los
// agentes (campo mcpServers del agente).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerConfig {
  name?: string;
  transport?: 'http' | 'sse' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

async function connect(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: 'agent-studio', version: '0.1.0' });
  const transport = cfg.transport ?? (cfg.command ? 'stdio' : 'http');
  if (transport === 'stdio') {
    if (!cfg.command) throw new Error('Falta el comando del servidor MCP (p. ej. npx)');
    await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) } }));
  } else {
    if (!cfg.url) throw new Error('Falta la URL del servidor MCP');
    const url = new URL(cfg.url);
    const requestInit = { headers: cfg.headers ?? {} };
    if (transport === 'sse') await client.connect(new SSEClientTransport(url, { requestInit }));
    else await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  }
  return client;
}

export async function withMcp<T>(cfg: McpServerConfig, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await connect(cfg);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const toolCache = new Map<string, { at: number; tools: McpTool[] }>();

export async function listTools(cfg: McpServerConfig, useCache = true): Promise<McpTool[]> {
  const key = JSON.stringify(cfg);
  const hit = toolCache.get(key);
  if (useCache && hit && Date.now() - hit.at < 5 * 60_000) return hit.tools;
  const tools = await withMcp(cfg, async (c) => (await c.listTools()).tools as McpTool[]);
  toolCache.set(key, { at: Date.now(), tools });
  return tools;
}

// Devuelve el texto de la respuesta (y el contenido estructurado si lo hay)
export async function callTool(cfg: McpServerConfig, name: string, args: Record<string, unknown>): Promise<{ text: string; structured?: unknown; isError: boolean }> {
  return withMcp(cfg, async (c) => {
    const r = (await c.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
    const text = (r.content ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
    return { text, structured: r.structuredContent, isError: Boolean(r.isError) };
  });
}
