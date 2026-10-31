// Proveedores de LLM con API compatible con OpenAI (/chat/completions): DeepSeek,
// Qwen, OpenRouter, Groq, Ollama… y los que se añadan con LLM_PROVIDERS.
//
// Un modelo se nombra "proveedor:modelo" (p. ej. "qwen:qwen-flash"). Un nombre sin
// proveedor ("deepseek-flash") se busca en las tablas de modelos y, si no está, va
// al proveedor por defecto (compatibilidad con los YAML de antes).
//
// Precios en USD por millón de tokens. Cambian con frecuencia: revisa la web de
// cada proveedor y ajústalos con LLM_PRICES (ver .env.example). Un modelo sin precio
// cuenta 0 en las métricas y no participa en la elección automática del más barato.

export interface Price { input: number; cacheHit: number; output: number }

export interface ProviderDef {
  key: string;
  name: string;
  baseUrl: string;
  envKey: string; // variable con la API key del servidor
  envBaseUrl?: string; // variable para cambiar la URL
  keyless?: boolean; // no pide clave (p. ej. Ollama local)
  defaultModel: string;
  models: Record<string, Price | null>;
  docs: string;
}

// Precios consultados el 31/10/2026 en las páginas oficiales:
// - DeepSeek (api-docs.deepseek.com/quick_start/pricing): tarifa de horas punta;
//   fuera de punta cuesta la mitad.
// - Qwen, Model Studio internacional (Singapur), tramo de hasta 256K tokens de
//   entrada y sin modo "thinking". No publica el precio de entrada con caché: se
//   cuenta como entrada normal (sin descuento).
export const PROVIDERS: ProviderDef[] = [
  {
    key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY', envBaseUrl: 'DEEPSEEK_BASE_URL',
    defaultModel: 'deepseek-flash', docs: 'https://api-docs.deepseek.com/quick_start/pricing',
    models: {
      'deepseek-flash': { input: 0.3, cacheHit: 0.006, output: 1.2 },
      'deepseek-v4-pro': { input: 1.32, cacheHit: 0.044, output: 3.96 },
    },
  },
  {
    key: 'qwen', name: 'Qwen (Alibaba Cloud)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', envKey: 'QWEN_API_KEY', envBaseUrl: 'QWEN_BASE_URL',
    defaultModel: 'qwen-flash', docs: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    models: {
      'qwen-flash': { input: 0.05, cacheHit: 0.05, output: 0.4 },
      'qwen-plus': { input: 0.4, cacheHit: 0.4, output: 1.2 },
      'qwen-max': { input: 1.6, cacheHit: 1.6, output: 6.4 },
    },
  },
  // Sin precios por defecto: ponlos en LLM_PRICES si los usas
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', defaultModel: 'openrouter/auto', docs: 'https://openrouter.ai/models', models: {} },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile', docs: 'https://groq.com/pricing', models: {} },
  { key: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', envKey: 'OLLAMA_API_KEY', envBaseUrl: 'OLLAMA_BASE_URL', keyless: true, defaultModel: 'qwen3:8b', docs: 'https://ollama.com/library', models: {} },
];

const fail = (message: string) => Object.assign(new Error(message), { status: 400 });

// Proveedores extra: LLM_PROVIDERS='[{"key":"kimi","name":"Kimi","baseUrl":"https://api.moonshot.ai/v1","envKey":"KIMI_API_KEY","defaultModel":"kimi-k2"}]'
function extraProviders(): ProviderDef[] {
  if (!process.env.LLM_PROVIDERS) return [];
  try {
    const list = JSON.parse(process.env.LLM_PROVIDERS) as Partial<ProviderDef>[];
    return list.filter((p) => p.key && p.baseUrl && p.defaultModel && /^[a-z0-9-]+$/.test(p.key)).map((p) => ({
      key: p.key!, name: p.name ?? p.key!, baseUrl: p.baseUrl!, envKey: p.envKey ?? `${p.key!.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      keyless: Boolean(p.keyless), defaultModel: p.defaultModel!, models: p.models ?? {}, docs: p.docs ?? '',
    }));
  } catch (err) {
    console.warn('⚠ LLM_PROVIDERS no es JSON válido:', (err as Error).message);
    return [];
  }
}

// LLM_PRICES='{"qwen:qwen-plus":{"input":0.4,"output":1.2}}' (cacheHit opcional = input)
function priceOverrides(): Record<string, Price> {
  const out: Record<string, Price> = {};
  if (process.env.LLM_PRICES) {
    try {
      for (const [ref, p] of Object.entries(JSON.parse(process.env.LLM_PRICES) as Record<string, Partial<Price>>)) {
        if (typeof p?.input === 'number' && typeof p?.output === 'number') out[ref] = { input: p.input, output: p.output, cacheHit: p.cacheHit ?? p.input };
      }
    } catch (err) {
      console.warn('⚠ LLM_PRICES no es JSON válido:', (err as Error).message);
    }
  }
  return out;
}

let cache: { providers: ProviderDef[]; prices: Record<string, Price> } | null = null;
function registry() {
  cache ??= { providers: [...PROVIDERS, ...extraProviders()], prices: priceOverrides() };
  return cache;
}
// Solo para las pruebas (relee las variables de entorno)
export function resetProviders(): void {
  cache = null;
}

export function listProviders(): ProviderDef[] {
  return registry().providers;
}

export function getProvider(key: string): ProviderDef | undefined {
  return registry().providers.find((p) => p.key === key);
}

export function baseUrlOf(p: ProviderDef): string {
  return ((p.envBaseUrl && process.env[p.envBaseUrl]) || p.baseUrl).replace(/\/$/, '');
}

export interface ModelRef { provider: ProviderDef; model: string; ref: string }

export const DEFAULT_PROVIDER = () => process.env.LLM_DEFAULT_PROVIDER || 'deepseek';

// "qwen:qwen-plus" | "qwen-plus" | "" (por defecto)
export function parseModel(spec: string | undefined): ModelRef {
  const s = String(spec ?? '').trim();
  const i = s.indexOf(':');
  let provider: ProviderDef | undefined;
  let model: string;
  if (i > 0 && getProvider(s.slice(0, i))) {
    provider = getProvider(s.slice(0, i));
    model = s.slice(i + 1) || provider!.defaultModel;
  } else if (s) {
    // Sin proveedor: el que tenga ese modelo en su tabla, o el proveedor por defecto
    provider = listProviders().find((p) => s in p.models) ?? getProvider(DEFAULT_PROVIDER());
    model = s;
  } else {
    provider = getProvider(DEFAULT_PROVIDER());
    model = '';
  }
  if (!provider) throw fail(`Proveedor de LLM desconocido: ${s || DEFAULT_PROVIDER()}`);
  model ||= provider.defaultModel;
  return { provider, model, ref: `${provider.key}:${model}` };
}

// Precio de un modelo. Las variables PRICE_*_PER_M de antes siguen valiendo para DeepSeek.
export function priceOf(ref: ModelRef): Price | null {
  const o = registry().prices[ref.ref];
  if (o) return o;
  if (ref.provider.key === 'deepseek' && process.env.PRICE_INPUT_PER_M && process.env.PRICE_OUTPUT_PER_M) {
    const input = Number(process.env.PRICE_INPUT_PER_M);
    return { input, output: Number(process.env.PRICE_OUTPUT_PER_M), cacheHit: Number(process.env.PRICE_CACHE_HIT_PER_M ?? input) };
  }
  return ref.provider.models[ref.model] ?? null;
}

export function costOf(price: Price | null, input: number, cacheHit: number, output: number): number {
  if (!price) return 0;
  return ((input - cacheHit) * price.input + cacheHit * price.cacheHit + output * price.output) / 1_000_000;
}

// Todos los modelos con precio conocido ("proveedor:modelo")
export function pricedModels(): ModelRef[] {
  const refs = new Set<string>();
  for (const p of listProviders()) for (const m of Object.keys(p.models)) refs.add(`${p.key}:${m}`);
  for (const r of Object.keys(registry().prices)) refs.add(r);
  return [...refs].flatMap((r) => { try { return [parseModel(r)]; } catch { return []; } }).filter((r) => priceOf(r));
}
