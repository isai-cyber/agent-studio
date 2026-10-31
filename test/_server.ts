// Servidor de pruebas en un puerto libre y un cliente HTTP con cookies.
// Importar SIEMPRE después de setupEnv() (lee la configuración al cargarse).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const { initAuth } = await import('../src/auth.ts');
  const { loadModules } = await import('../src/modules/registry.ts');
  const { createAppServer } = await import('../src/server.ts');
  const { setTenantFilter } = await import('../src/flows.ts');
  const { isTenantActive } = await import('../src/tenancy/tenants.ts');
  const { closeDb, dbEnabled } = await import('../src/db/pool.ts');
  if (dbEnabled) await initAuth();
  await loadModules();
  setTenantFilter(isTenantActive);
  const server: Server = createAppServer();
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      if (dbEnabled) await closeDb();
    },
  };
}

export interface Res { status: number; body: any; headers: Headers }

export class Client {
  cookie = '';
  base: string;
  apiKey?: string;
  constructor(base: string, apiKey?: string) {
    this.base = base;
    this.apiKey = apiKey;
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined && typeof body !== 'string') h['content-type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    return { status: res.status, body: type.includes('json') && text ? JSON.parse(text) : text, headers: res.headers };
  }

  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  put = (p: string, b: unknown = {}) => this.req('PUT', p, b);
  del = (p: string, b?: unknown) => this.req('DELETE', p, b);

  async register(name: string, email: string, invitation?: string): Promise<Res> {
    return this.post('/api/auth/register', { name, email, password: 'clave-segura-123', invitation });
  }

  // Llamada JSON-RPC al servidor MCP por HTTP
  async mcp(method: string, params: unknown = {}): Promise<Res> {
    return this.req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, { accept: 'application/json, text/event-stream' });
  }
}

// Saca el token de un enlace de invitación (/?invite=...)
export const tokenOf = (link: string) => new URL(link).searchParams.get('invite')!;
