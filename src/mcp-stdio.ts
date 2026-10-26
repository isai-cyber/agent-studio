// Servidor MCP por stdio, para clientes que lanzan el proceso ellos mismos
// (Claude Desktop, Cursor, opencode...). Ver la pantalla "Conectar" para la config.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.ts';

// stdout es el canal del protocolo: cualquier log debe ir a stderr
console.log = console.error;

await createMcpServer(1).connect(new StdioServerTransport());
