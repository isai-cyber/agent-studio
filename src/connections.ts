// Conexiones: credenciales guardadas por app (como "Elegir conexión" en Zapier).
// Van por empresa en data/tenants/<id>/connections.json, cifradas con
// AES-256-GCM y la clave de la empresa (src/tenancy/crypto.ts). Nunca se
// devuelven completas a la interfaz.
//
// Las variables FLOW_<APP>_<CAMPO> del .env solo cuentan para la empresa Default:
// son del dueño de la instalación y no deben llegar a otras empresas.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DEFAULT_TENANT_ID, tenantDataPath } from './tenancy/paths.ts';
import { decrypt, encrypt } from './tenancy/crypto.ts';

interface Store { version: 1; apps: Record<string, string> }
type Plain = Record<string, Record<string, string>>;

const file = (tenantId: number) => tenantDataPath(tenantId, 'connections.json');
const ctxOf = (app: string) => `connection:${app}`;

async function readStore(tenantId: number): Promise<Store> {
  try {
    const s = JSON.parse(await readFile(file(tenantId), 'utf8')) as Store;
    return s && s.apps ? s : { version: 1, apps: {} };
  } catch {
    return { version: 1, apps: {} };
  }
}

async function readAll(tenantId: number): Promise<Plain> {
  const s = await readStore(tenantId);
  const out: Plain = {};
  for (const [app, payload] of Object.entries(s.apps)) {
    try { out[app] = JSON.parse(decrypt(tenantId, ctxOf(app), payload)); }
    catch (err) { console.warn(`[conexiones] no se pudo descifrar ${tenantId}/${app}: ${(err as Error).message}`); }
  }
  return out;
}

async function writeAll(tenantId: number, all: Plain): Promise<void> {
  const s: Store = { version: 1, apps: {} };
  for (const [app, fields] of Object.entries(all)) s.apps[app] = encrypt(tenantId, ctxOf(app), JSON.stringify(fields));
  await mkdir(tenantDataPath(tenantId), { recursive: true });
  await writeFile(file(tenantId), JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(file(tenantId), 0o600);
}

const envKey = (app: string, field: string) => `FLOW_${app}_${field}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const fromEnv = (tenantId: number, app: string, field: string) => (tenantId === DEFAULT_TENANT_ID ? process.env[envKey(app, field)] : undefined);

// Valores completos (solo para el servidor al ejecutar acciones)
export async function getConnection(tenantId: number, app: string, fields: string[] = []): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...((await readAll(tenantId))[app] ?? {}) };
  for (const f of fields) if (!out[f] && fromEnv(tenantId, app, f)) out[f] = fromEnv(tenantId, app, f)!;
  return out;
}

export async function setConnection(tenantId: number, app: string, values: Record<string, string>): Promise<{ before: string[]; after: string[] }> {
  const all = await readAll(tenantId);
  const cur = all[app] ?? {};
  const before = Object.keys(cur);
  // Campo vacío = no cambiar (la interfaz no conoce el secreto guardado)
  for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && v.trim() !== '') cur[k] = v.trim();
  all[app] = cur;
  await writeAll(tenantId, all);
  return { before, after: Object.keys(cur) };
}

export async function deleteConnection(tenantId: number, app: string): Promise<boolean> {
  const all = await readAll(tenantId);
  const had = app in all;
  delete all[app];
  await writeAll(tenantId, all);
  return had;
}

const mask = (v: string) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

// Para la interfaz: qué campos hay guardados, con los secretos enmascarados
export async function listMasked(tenantId: number, secretFields: Record<string, string[]>): Promise<Record<string, Record<string, string>>> {
  const all = await readAll(tenantId);
  const out: Record<string, Record<string, string>> = {};
  for (const [app, fields] of Object.entries(all)) {
    out[app] = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (secretFields[app] ?? []).includes(k) ? mask(v) : v]));
  }
  // Las que vienen del .env también cuentan como conectadas (solo en Default)
  for (const [app, fields] of Object.entries(secretFields)) {
    for (const f of fields) if (fromEnv(tenantId, app, f) && !out[app]?.[f]) (out[app] ??= {})[f] = '(desde .env)';
  }
  return out;
}

// ¿Están todos los campos obligatorios de la app? (para "Requiere configuración")
export async function connectedApps(tenantId: number, required: Record<string, string[]>): Promise<Set<string>> {
  const all = await readAll(tenantId);
  const ok = new Set<string>();
  for (const [app, fields] of Object.entries(required)) {
    const have = (f: string) => Boolean(all[app]?.[f] || fromEnv(tenantId, app, f));
    if (all[app] || fields.some((f) => fromEnv(tenantId, app, f))) {
      if (fields.every(have)) ok.add(app);
    }
  }
  return ok;
}
