// Conexiones: credenciales guardadas por app (como "Elegir conexión" en Zapier).
// Se guardan en data/connections.json con permisos 0600 y nunca se devuelven
// completas a la interfaz. También se aceptan desde el .env como FLOW_<APP>_<CAMPO>.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './store.ts';

const FILE = join(ROOT, 'data', 'connections.json');
type Store = Record<string, Record<string, string>>;

async function readAll(): Promise<Store> {
  try { return JSON.parse(await readFile(FILE, 'utf8')); } catch { return {}; }
}
async function writeAll(s: Store): Promise<void> {
  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(FILE, 0o600);
}

const envKey = (app: string, field: string) => `FLOW_${app}_${field}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');

// Valores completos (solo para el servidor al ejecutar acciones)
export async function getConnection(app: string, fields: string[] = []): Promise<Record<string, string>> {
  const saved = (await readAll())[app] ?? {};
  const out: Record<string, string> = { ...saved };
  for (const f of fields) if (!out[f] && process.env[envKey(app, f)]) out[f] = process.env[envKey(app, f)]!;
  return out;
}

export async function setConnection(app: string, values: Record<string, string>): Promise<void> {
  const all = await readAll();
  const cur = all[app] ?? {};
  // Campo vacío = no cambiar (la interfaz no conoce el secreto guardado)
  for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && v.trim() !== '') cur[k] = v.trim();
  all[app] = cur;
  await writeAll(all);
}

export async function deleteConnection(app: string): Promise<void> {
  const all = await readAll();
  delete all[app];
  await writeAll(all);
}

const mask = (v: string) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

// Para la interfaz: qué campos hay guardados, enmascarados
export async function listMasked(secretFields: Record<string, string[]>): Promise<Record<string, Record<string, string>>> {
  const all = await readAll();
  const out: Record<string, Record<string, string>> = {};
  for (const [app, fields] of Object.entries(all)) {
    out[app] = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (secretFields[app] ?? []).includes(k) ? mask(v) : v]));
  }
  // Las que vienen del .env también cuentan como conectadas
  for (const [app, fields] of Object.entries(secretFields)) {
    for (const f of fields) if (process.env[envKey(app, f)] && !out[app]?.[f]) (out[app] ??= {})[f] = '(desde .env)';
  }
  return out;
}
