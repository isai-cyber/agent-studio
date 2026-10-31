// Módulo básico: disparadores (manual, webhook, programado) y control de flujo.
import type { ModuleDef } from '../../src/modules/sdk.ts';

const OPS = [
  { label: 'es igual a', value: 'eq' }, { label: 'no es igual a', value: 'ne' }, { label: 'contiene', value: 'contains' },
  { label: 'no contiene', value: 'not_contains' }, { label: 'mayor que', value: 'gt' }, { label: 'menor que', value: 'lt' },
  { label: 'existe (no vacío)', value: 'exists' }, { label: 'está vacío', value: 'empty' },
];

function compare(left: unknown, op: string, right: unknown): boolean {
  const l = left === undefined || left === null ? '' : typeof left === 'object' ? JSON.stringify(left) : String(left);
  const r = right === undefined || right === null ? '' : String(right);
  const ln = Number(l), rn = Number(r);
  switch (op) {
    case 'eq': return l.toLowerCase() === r.toLowerCase();
    case 'ne': return l.toLowerCase() !== r.toLowerCase();
    case 'contains': return l.toLowerCase().includes(r.toLowerCase());
    case 'not_contains': return !l.toLowerCase().includes(r.toLowerCase());
    case 'gt': return !Number.isNaN(ln) && !Number.isNaN(rn) && ln > rn;
    case 'lt': return !Number.isNaN(ln) && !Number.isNaN(rn) && ln < rn;
    case 'exists': return l.trim() !== '';
    case 'empty': return l.trim() === '';
  }
  return false;
}

export default {
  key: 'core',
  name: 'Básicos',
  description: 'Disparadores (manual, webhook, programado) y control del flujo: filtros, esperas y variables.',
  icon: '⚡',
  color: '#8b5cf6',
  category: 'Básicos',
  author: 'CrawStudio A.I',
  version: '1.0.0',
  triggers: [
    { key: 'manual', name: 'Manual', type: 'manual', description: 'Se ejecuta con el botón "Probar" o desde la API.' },
    {
      key: 'webhook', name: 'Webhook', type: 'webhook',
      description: 'Se ejecuta al recibir una petición en /hooks/<id-del-flujo>. El cuerpo, la query y las cabeceras quedan en {{trigger}}.',
      arguments: [{ key: 'secret', label: 'Secreto (opcional)', type: 'string', description: 'Si lo pones, la petición debe incluir ?token=<secreto> o la cabecera X-Flow-Token.' }],
    },
    {
      key: 'schedule', name: 'Programado', type: 'schedule', description: 'Se ejecuta cada cierto tiempo.',
      arguments: [{ key: 'everyMinutes', label: 'Cada (minutos)', type: 'number', required: true, default: 60 }],
    },
  ],
  actions: [
    {
      key: 'filter', name: 'Filtro: continuar solo si…', description: 'Detiene el flujo si la condición no se cumple.',
      arguments: [
        { key: 'left', label: 'Valor', type: 'string', required: true, variables: true, placeholder: '{{trigger.body.estado}}' },
        { key: 'op', label: 'Condición', type: 'dropdown', required: true, default: 'eq', options: OPS },
        { key: 'right', label: 'Comparar con', type: 'string', variables: true },
      ],
      async run(ctx) {
        const ok = compare(ctx.args.left, String(ctx.args.op), ctx.args.right);
        return ok ? { cumple: true } : ctx.stop(`"${ctx.args.left}" no ${OPS.find((o) => o.value === ctx.args.op)?.label ?? ctx.args.op} "${ctx.args.right ?? ''}"`);
      },
    },
    {
      key: 'delay', name: 'Esperar', description: 'Pausa el flujo unos segundos (máximo 60).',
      arguments: [{ key: 'seconds', label: 'Segundos', type: 'number', required: true, default: 5 }],
      async run(ctx) {
        const s = Math.min(60, Math.max(0, Number(ctx.args.seconds) || 0));
        await new Promise((r) => setTimeout(r, s * 1000));
        return { esperado: s };
      },
    },
    {
      key: 'set', name: 'Guardar variables', description: 'Crea valores reutilizables en los pasos siguientes.',
      arguments: [{ key: 'values', label: 'Valores (JSON)', type: 'json', required: true, variables: true, default: '{\n  "clave": "valor"\n}' }],
      async run(ctx) {
        const v = ctx.args.values;
        return typeof v === 'string' ? JSON.parse(v) : v;
      },
    },
  ],
} satisfies ModuleDef;
