// Validador mínimo de JSON Schema para la configuración de cada módulo (el
// subconjunto que usa src/features/registry.ts). Devuelve la configuración
// limpia (con valores por defecto) o lanza un error 400 con todos los fallos.
import type { JsonSchema } from './registry.ts';

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): unknown {
  const at = path || 'configuración';
  if (value === undefined) return schema.default;
  if (schema.enum && !schema.enum.includes(value as string | number)) { errors.push(`${at}: debe ser uno de ${schema.enum.join(', ')}`); return value; }
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${at}: debe ser un objeto`); return value; }
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      for (const k of Object.keys(value)) if (!props[k] && schema.additionalProperties !== true) errors.push(`${path ? `${path}.` : ''}${k}: campo desconocido`);
      for (const [k, sub] of Object.entries(props)) {
        const v = check(sub, (value as Record<string, unknown>)[k], path ? `${path}.${k}` : k, errors);
        if (v !== undefined) out[k] = v;
      }
      for (const r of schema.required ?? []) if (out[r] === undefined || out[r] === '') errors.push(`${path ? `${path}.` : ''}${r}: es obligatorio`);
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${at}: debe ser una lista`); return value; }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: máximo ${schema.maxItems} elementos`);
      return value.map((v, i) => (schema.items ? check(schema.items, v, `${at}[${i}]`, errors) : v));
    }
    case 'string': {
      if (typeof value !== 'string') { errors.push(`${at}: debe ser texto`); return value; }
      if (value === '' && !schema.minLength) return value;
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: mínimo ${schema.minLength} caracteres`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: máximo ${schema.maxLength} caracteres`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: formato no válido`);
      if (schema.format === 'uri' && !/^https?:\/\/[^\s/]+/.test(value)) errors.push(`${at}: debe ser una URL (https://…)`);
      if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${at}: debe ser un email`);
      return value;
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n) || (schema.type === 'integer' && !Number.isInteger(n))) { errors.push(`${at}: debe ser un número${schema.type === 'integer' ? ' entero' : ''}`); return value; }
      if (schema.minimum !== undefined && n < schema.minimum) errors.push(`${at}: mínimo ${schema.minimum}`);
      if (schema.maximum !== undefined && n > schema.maximum) errors.push(`${at}: máximo ${schema.maximum}`);
      return n;
    }
    case 'boolean':
      if (typeof value !== 'boolean') { errors.push(`${at}: debe ser verdadero o falso`); return value; }
      return value;
    default:
      return value;
  }
}

export function validateConfig(schema: JsonSchema, value: unknown): Record<string, unknown> {
  const errors: string[] = [];
  const out = check({ ...schema, type: 'object' }, value ?? {}, '', errors) as Record<string, unknown>;
  if (errors.length) throw Object.assign(new Error(`Configuración no válida: ${errors.join('; ')}`), { status: 400, errors });
  return out;
}

// Valores por defecto del esquema
export function defaultConfig(schema: JsonSchema): Record<string, unknown> {
  return validateConfig(schema, {});
}
