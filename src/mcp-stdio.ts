// Servidor MCP por stdio, para clientes que lanzan el proceso ellos mismos
// (Claude Desktop, Cursor, opencode...). Ver la pantalla "Conectar" para la config.
//
// Quien lanza el proceso ya tiene acceso al servidor, pero aun así se identifica
// con una clave de API de su empresa (AGENT_STUDIO_API_KEY) y solo tiene sus scopes.
// Sin MariaDB, o con la clave global, trabaja sobre la empresa Default.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { IncomingMessage } from 'node:http';
import { createMcpServer } from './mcp.ts';
import { verifyApiKey } from './tenancy/apikeys.ts';
import { contextForApiKey, localContext } from './authz/context.ts';
import { dbEnabled } from './db/pool.ts';

// stdout es el canal del protocolo: cualquier log debe ir a stderr
console.log = console.error;

const key = process.env.AGENT_STUDIO_MCP_KEY ?? process.env.AGENT_STUDIO_API_KEY;
let ctx;
if (!dbEnabled) ctx = localContext();
else {
  const auth = key ? await verifyApiKey({ headers: { authorization: `Bearer ${key}` } } as IncomingMessage) : null;
  if (!auth) {
    console.error('✖ Define AGENT_STUDIO_MCP_KEY con una clave de API de tu empresa (Configuración → Claves de API).');
    process.exit(1);
  }
  ctx = await contextForApiKey(auth, null);
}
await createMcpServer(ctx).connect(new StdioServerTransport());
