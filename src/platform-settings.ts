// Ajustes de la plataforma que gestiona el superadmin desde la interfaz
// (Empresas y planes → Ajustes): las claves de IA con las que das el servicio a
// tus clientes (DeepSeek, Qwen…), qué modelo se usa en cada tarea, y las cuentas
// de Stripe y Mercado Pago con las que cobras a tus clientes.
//
// Se guardan en data/platform/settings.json; los secretos van cifrados
// (AES-256-GCM, clave derivada de ENCRYPTION_KEY solo para la plataforma) y
// nunca se devuelven completos. Lo que se ponga aquí manda sobre el .env.
// Tus clientes no ponen claves: usan las tuyas.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './tenancy/paths.ts';
import { decryptPlatform, encryptPlatform } from './tenancy/crypto.ts';

export interface PlatformSettings {
  llmKeys: Record<string, string>; // proveedor → API key
  llm: { model?: string; classify?: string; flows?: string; fallbacks?: string[] };
  billing: {
    stripe?: { secretKey?: string; currency?: string };
    mercadopago?: { accessToken?: string; currency?: string };
    successUrl?: string; // a dónde vuelve el cliente tras pagar
  };
}

// Campos secretos: van cifrados y enmascarados
const SECRET = (path: string) => path.startsWith('llmKeys.') || path === 'billing.stripe.secretKey' || path === 'billing.mercadopago.accessToken';

const file = () => join(DATA_DIR, 'platform', 'settings.json');
const empty = (): PlatformSettings => ({ llmKeys: {}, llm: {}, billing: {} });

let cache: PlatformSettings | null = null;

function walk(obj: Record<string, unknown>, fn: (path: string, value: unknown) => unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? walk(v as Record<string, unknown>, fn, path) : fn(path, v);
  }
  return out;
}

// Lectura síncrona (con caché): la usa el cliente de LLM en cada llamada
export function getPlatformSettings(): PlatformSettings {
  if (cache) return cache;
  if (!existsSync(file())) return (cache = empty());
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    cache = { ...empty(), ...(walk(raw, (path, v) => (SECRET(path) && typeof v === 'string' && v ? decryptPlatform(path, v) : v)) as unknown as PlatformSettings) };
  } catch (err) {
    console.error('✖ No se pudieron leer los ajustes de la plataforma:', (err as Error).message);
    cache = empty();
  }
  return cache;
}

const mask = (v: string) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

// Para la interfaz: los secretos enmascarados
export function maskedSettings(): PlatformSettings {
  return walk(getPlatformSettings() as unknown as Record<string, unknown>, (path, v) => (SECRET(path) && typeof v === 'string' && v ? mask(v) : v)) as unknown as PlatformSettings;
}

const fail = (message: string) => Object.assign(new Error(message), { status: 400 });
const MODEL = /^(auto|[a-z0-9-]+:[\w./:-]+)$/;
const CURRENCY = /^[A-Z]{3}$/;

// Aplica un cambio parcial. Un secreto vacío no cambia el guardado; null lo borra.
// Devuelve qué campos cambiaron (sin valores secretos) para la auditoría.
// En un cambio, null borra un secreto guardado
export interface SettingsPatch {
  llmKeys?: Record<string, string | null>;
  llm?: PlatformSettings['llm'];
  billing?: {
    stripe?: { secretKey?: string | null; currency?: string };
    mercadopago?: { accessToken?: string | null; currency?: string };
    successUrl?: string;
  };
}

export function updatePlatformSettings(patch: SettingsPatch): { changed: string[] } {
  const cur = structuredClone(getPlatformSettings());
  const changed: string[] = [];
  const setSecret = (path: string, current: string | undefined, next: unknown, apply: (v: string | undefined) => void) => {
    if (next === undefined || next === '') return;
    if (next === null) { if (current) { apply(undefined); changed.push(path); } return; }
    const v = String(next).trim();
    if (v.length > 300 || /\s/.test(v)) throw fail(`${path}: clave no válida`);
    if (v !== current) { apply(v); changed.push(path); }
  };
  for (const [provider, key] of Object.entries(patch.llmKeys ?? {})) {
    if (!/^[a-z0-9-]+$/.test(provider)) throw fail('Proveedor no válido');
    setSecret(`llmKeys.${provider}`, cur.llmKeys[provider], key, (v) => { if (v) cur.llmKeys[provider] = v; else delete cur.llmKeys[provider]; });
  }
  if (patch.llm) {
    for (const k of ['model', 'classify', 'flows'] as const) {
      if (patch.llm[k] === undefined) continue;
      const v = String(patch.llm[k] ?? '').trim();
      if (v && !MODEL.test(v)) throw fail(`Modelo no válido: ${v} (usa proveedor:modelo, p. ej. qwen:qwen-flash)`);
      if (k !== 'classify' && v === 'auto') throw fail('«auto» solo vale para clasificar');
      if ((cur.llm[k] ?? '') !== v) { if (v) cur.llm[k] = v; else delete cur.llm[k]; changed.push(`llm.${k}`); }
    }
    if (patch.llm.fallbacks !== undefined) {
      const list = (patch.llm.fallbacks ?? []).map((x) => String(x).trim()).filter(Boolean);
      for (const f of list) if (!MODEL.test(f) || f === 'auto') throw fail(`Modelo de respaldo no válido: ${f}`);
      if (JSON.stringify(list) !== JSON.stringify(cur.llm.fallbacks ?? [])) { cur.llm.fallbacks = list; changed.push('llm.fallbacks'); }
    }
  }
  if (patch.billing) {
    const b = patch.billing;
    for (const p of ['stripe', 'mercadopago'] as const) {
      const next = b[p];
      if (!next) continue;
      const curP = (cur.billing[p] ??= {});
      const secretKey = p === 'stripe' ? 'secretKey' : 'accessToken';
      setSecret(`billing.${p}.${secretKey}`, (curP as Record<string, string | undefined>)[secretKey], (next as Record<string, unknown>)[secretKey], (v) => { (curP as Record<string, string | undefined>)[secretKey] = v; });
      if (next.currency !== undefined) {
        const c = String(next.currency).toUpperCase();
        if (!CURRENCY.test(c)) throw fail('La moneda debe ser un código de 3 letras (USD, MXN…)');
        if (curP.currency !== c) { curP.currency = c; changed.push(`billing.${p}.currency`); }
      }
    }
    if (b.successUrl !== undefined) {
      const u = String(b.successUrl).trim();
      if (u && !/^https?:\/\/\S+$/.test(u)) throw fail('La URL de retorno debe empezar por https://');
      if ((cur.billing.successUrl ?? '') !== u) { cur.billing.successUrl = u || undefined; changed.push('billing.successUrl'); }
    }
  }
  if (changed.length) save(cur);
  return { changed };
}

function save(s: PlatformSettings): void {
  const enc = walk(s as unknown as Record<string, unknown>, (path, v) => (SECRET(path) && typeof v === 'string' && v ? encryptPlatform(path, v) : v));
  mkdirSync(join(DATA_DIR, 'platform'), { recursive: true });
  writeFileSync(file(), JSON.stringify(enc, null, 2), { mode: 0o600 });
  chmodSync(file(), 0o600);
  cache = s;
}

// Solo para las pruebas
export function resetPlatformSettings(): void {
  cache = null;
}
