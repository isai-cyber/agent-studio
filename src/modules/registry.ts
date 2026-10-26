// Registro de módulos: carga los integrados (modules/) y los de la comunidad
// (modules-community/), y permite instalar uno nuevo desde una URL.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../store.ts';
import type { ActionDef, ModuleDef, TriggerDef } from './sdk.ts';

export const BUILTIN_DIR = join(ROOT, 'modules');
export const COMMUNITY_DIR = join(ROOT, 'modules-community');
const ENTRY = ['index.ts', 'index.js', 'index.mjs'];

interface Loaded { def: ModuleDef; source: 'integrado' | 'comunidad'; dir: string }
let modules = new Map<string, Loaded>();
export const loadErrors: { dir: string; error: string }[] = [];

function validate(def: unknown, dir: string): ModuleDef {
  const m = def as ModuleDef;
  if (!m || typeof m !== 'object') throw new Error('el archivo no exporta un objeto por defecto');
  if (!m.key || !/^[a-z0-9][a-z0-9-]*$/.test(m.key)) throw new Error('falta "key" (minúsculas, números y guiones)');
  if (!m.name) throw new Error('falta "name"');
  for (const a of m.actions ?? []) if (!a.key || typeof a.run !== 'function') throw new Error(`acción inválida en ${dir}: necesita key y run()`);
  for (const t of m.triggers ?? []) if (!t.key || !t.type) throw new Error(`disparador inválido en ${dir}: necesita key y type`);
  return m;
}

// Un archivo puede exportar un módulo o una lista de módulos (p. ej. un catálogo de apps)
async function importModules(dir: string): Promise<ModuleDef[] | null> {
  const entry = ENTRY.map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!entry) return null;
  // ?v= fuerza a recargar el archivo si cambió
  const mod = await import(`${pathToFileURL(entry).href}?v=${Date.now()}`);
  const list = Array.isArray(mod.default) ? mod.default : [mod.default];
  return list.map((m: unknown) => validate(m, dir));
}
async function importModule(dir: string): Promise<ModuleDef | null> {
  return (await importModules(dir))?.[0] ?? null;
}

export async function loadModules(): Promise<void> {
  const next = new Map<string, Loaded>();
  loadErrors.length = 0;
  for (const [base, source] of [[BUILTIN_DIR, 'integrado'], [COMMUNITY_DIR, 'comunidad']] as const) {
    if (!existsSync(base)) continue;
    for (const e of await readdir(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const dir = join(base, e.name);
      try {
        const defs = await importModules(dir);
        if (!defs) continue;
        for (const def of defs) {
          if (next.has(def.key)) throw new Error(`clave duplicada "${def.key}"`);
          next.set(def.key, { def, source, dir });
        }
      } catch (err) {
        loadErrors.push({ dir, error: (err as Error).message });
        console.warn(`[módulos] ${dir}: ${(err as Error).message}`);
      }
    }
  }
  modules = next;
  logoFiles = null;
}

export function getModule(key: string): Loaded | undefined {
  return modules.get(key);
}
export function getAction(moduleKey: string, actionKey: string): ActionDef | undefined {
  return modules.get(moduleKey)?.def.actions?.find((a) => a.key === actionKey);
}
export function getTrigger(moduleKey: string, triggerKey: string): TriggerDef | undefined {
  return modules.get(moduleKey)?.def.triggers?.find((t) => t.key === triggerKey);
}

// Logos por convención: public/logos/ui/<key>.svg (iconos propios) o public/logos/<key>.<ext>
const LOGO_DIR = join(ROOT, 'public', 'logos');
let logoFiles: Map<string, string> | null = null;
function logoFor(key: string): string | null {
  if (!logoFiles) {
    logoFiles = new Map();
    for (const [dir, prefix] of [[LOGO_DIR, '/logos/'], [join(LOGO_DIR, 'ui'), '/logos/ui/']] as const) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) { const m = f.match(/^(.+)\.(svg|png|jpe?g|gif|webp|ico)$/); if (m) logoFiles.set(m[1], prefix + f); }
    }
  }
  return logoFiles.get(key) ?? null;
}

// Versión serializable para la interfaz (sin funciones)
export function listModules() {
  return [...modules.values()].map(({ def, source }) => ({
    key: def.key, name: def.name, description: def.description ?? '', icon: def.icon ?? '🧩', color: def.color ?? '#8b5cf6',
    logo: def.logo ?? logoFor(def.key), badge: def.badge ?? (def.auth ? 'App' : ''),
    category: def.category ?? 'Otros', author: def.author ?? '', version: def.version ?? '', homepage: def.homepage ?? '', source,
    auth: def.auth ?? null,
    triggers: (def.triggers ?? []).map(({ run: _r, ...t }) => t),
    actions: (def.actions ?? []).map(({ run: _r, ...a }) => a),
  }));
}

// Instala un módulo de la comunidad desde la URL de un único archivo .js/.ts.
// Ojo: ejecuta código en el servidor; instala solo de fuentes de confianza.
export async function installFromUrl(url: string): Promise<{ key: string; name: string }> {
  if (!/^https:\/\//.test(url)) throw Object.assign(new Error('La URL debe empezar por https://'), { status: 400 });
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(`No se pudo descargar (${res.status})`), { status: 400 });
  const code = await res.text();
  if (code.length > 300_000) throw Object.assign(new Error('El archivo es demasiado grande (máx. 300 KB)'), { status: 400 });
  if (!/export\s+default/.test(code)) throw Object.assign(new Error('El archivo no tiene "export default"'), { status: 400 });

  await mkdir(COMMUNITY_DIR, { recursive: true });
  const tmp = join(COMMUNITY_DIR, `.tmp-${randomUUID()}`);
  await mkdir(tmp);
  const file = join(tmp, url.endsWith('.ts') ? 'index.ts' : 'index.js');
  await writeFile(file, `// Instalado desde ${url}\n${code}`, 'utf8');
  try {
    const def = await importModule(tmp);
    if (!def) throw new Error('No se encontró el archivo del módulo');
    if (modules.has(def.key) && modules.get(def.key)!.source === 'integrado') throw new Error(`Ya existe un módulo integrado con la clave "${def.key}"`);
    const dest = join(COMMUNITY_DIR, def.key);
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
    await loadModules();
    return { key: def.key, name: def.name };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw Object.assign(new Error(`Módulo no válido: ${(err as Error).message}`), { status: 400 });
  }
}

export async function uninstall(key: string): Promise<void> {
  const m = modules.get(key);
  if (!m) throw Object.assign(new Error('Módulo no encontrado'), { status: 404 });
  if (m.source !== 'comunidad') throw Object.assign(new Error('Los módulos integrados no se pueden desinstalar'), { status: 400 });
  await rm(m.dir, { recursive: true, force: true });
  await loadModules();
}
