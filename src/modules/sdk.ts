// SDK de módulos de Agent Studio.
//
// Un módulo es un archivo (modules/<clave>/index.ts o .js) que exporta por defecto un
// objeto con disparadores (triggers) y acciones (actions). La forma se inspira en las
// "apps" de Automatisch (name, key, arguments...) para que resulte familiar, pero es una
// implementación propia.
//
//   export default {
//     key: 'saludo', name: 'Saludo', icon: '👋', color: '#8b5cf6', version: '1.0.0',
//     actions: [{
//       key: 'saludar', name: 'Saludar',
//       arguments: [{ key: 'nombre', label: 'Nombre', type: 'string', required: true, variables: true }],
//       async run(ctx) { return { texto: `¡Hola, ${ctx.args.nombre}!` }; },
//     }],
//   };

export type ArgumentType = 'string' | 'text' | 'number' | 'boolean' | 'dropdown' | 'json' | 'agent';

export interface Argument {
  key: string;
  label: string;
  type: ArgumentType;
  required?: boolean;
  description?: string;
  default?: unknown;
  placeholder?: string;
  options?: { label: string; value: string }[];
  variables?: boolean; // admite {{variables}} de pasos anteriores
}

export interface StepContext {
  args: Record<string, any>;
  trigger: any;
  steps: Record<string, any>;
  env: Record<string, string | undefined>; // solo variables FLOW_* del .env
  flow: { id: string; name: string };
  tenant: { id: number }; // empresa dueña del flujo
  log: (msg: string) => void;
  // Credenciales guardadas para una app (paso "Elegir conexión" o FLOW_<APP>_<CAMPO> del .env)
  connection: (app: string, fields?: string[]) => Promise<Record<string, string>>;
  fetchJson: (url: string, init?: RequestInit) => Promise<any>;
  agentStudio: {
    chat: (agentId: string, message: string, sessionId?: string) => Promise<{ sessionId: string; reply: string; options: string[]; topic: string | null }>;
    listAgents: () => Promise<{ id: string; name: string }[]>;
    // purpose 'classify' usa el modelo barato de clasificación (LLM_MODEL_CLASSIFY)
    llm: (prompt: string, system?: string, temperature?: number, purpose?: 'flow' | 'classify') => Promise<string>;
    tts: (text: string, voiceId?: string) => Promise<{ url: string; bytes: number }>;
    // Decisiones tipadas: con Jev si está configurado (rápido y barato); si no, con el LLM de clasificar
    choose: (state: string, options: string[], instructions?: string) => Promise<{ choice: string; confidence: number | null; via: 'jev' | 'llm' }>;
    yesNo: (state: string, statement: string) => Promise<{ probability: number; via: 'jev' | 'llm' }>;
  };
  stop: (reason?: string) => { __stop: true; reason: string };
}

export interface ActionDef {
  key: string;
  name: string;
  description?: string;
  arguments?: Argument[];
  run: (ctx: StepContext) => Promise<unknown>;
}

export type TriggerType = 'manual' | 'webhook' | 'schedule' | 'event' | 'poll';

export interface TriggerDef {
  key: string;
  name: string;
  description?: string;
  type: TriggerType;
  event?: string; // para type 'event', p. ej. 'agent.turn'
  arguments?: Argument[];
  // type 'poll': devuelve elementos; los nuevos (por id) disparan el flujo
  run?: (ctx: StepContext) => Promise<{ id: string; [k: string]: unknown }[]>;
}

export interface ModuleDef {
  key: string;
  name: string;
  description?: string;
  icon?: string;
  logo?: string; // URL o ruta (/logos/x.svg) del logo de la app; si falta, se busca public/logos/<key>.*
  badge?: string; // etiqueta corta en la tarjeta: 'API', 'MCP'...
  color?: string;
  category?: string;
  author?: string;
  version?: string;
  homepage?: string;
  // Datos de conexión que pide la app (token, subdominio...). Ver http-app.ts
  auth?: { fields: { key: string; label: string; secret?: boolean; placeholder?: string; help?: string; optional?: boolean }[]; help?: string };
  triggers?: TriggerDef[];
  actions?: ActionDef[];
}

// Ayuda opcional para tener autocompletado en editores
export const defineModule = (m: ModuleDef): ModuleDef => m;

// ---------- plantillas {{ruta.a.dato}} ----------

function lookup(path: string, vars: Record<string, unknown>): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), vars);
}

export function render(template: string, vars: Record<string, unknown>): unknown {
  // Si el valor es exactamente una variable, se conserva su tipo (objeto, número...)
  const whole = template.match(/^\s*\{\{\s*([\w.-]+)\s*\}\}\s*$/);
  if (whole) return lookup(whole[1], vars);
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, p: string) => {
    const v = lookup(p, vars);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function renderDeep(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') return render(value, vars);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars)]));
  return value;
}

// Variables de entorno visibles para los flujos: solo FLOW_* (los secretos del
// servidor, como DEEPSEEK_API_KEY, no se exponen a módulos ni plantillas) y solo
// en la empresa Default: el .env es del dueño de la instalación.
export function flowEnv(tenantId: number): Record<string, string | undefined> {
  if (tenantId !== 1) return {};
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FLOW_')));
}
