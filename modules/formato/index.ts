// Transformaciones de texto y datos.
import type { ModuleDef } from '../../src/modules/sdk.ts';

export default {
  key: 'formato',
  name: 'Formato',
  description: 'Plantillas de texto, cambios de mayúsculas, extraer JSON y fechas.',
  icon: '🔧',
  color: '#93dfbc',
  category: 'Utilidades',
  author: 'CrawStudio A.I',
  version: '1.0.0',
  actions: [
    {
      key: 'template', name: 'Plantilla de texto', description: 'Combina texto y variables. Resultado en {{steps.<id>.text}}.',
      arguments: [{ key: 'template', label: 'Plantilla', type: 'text', required: true, variables: true, placeholder: 'Nuevo mensaje de {{trigger.body.nombre}}: {{trigger.body.mensaje}}' }],
      async run(ctx) { return { text: String(ctx.args.template ?? '') }; },
    },
    {
      key: 'case', name: 'Mayúsculas / minúsculas',
      arguments: [
        { key: 'text', label: 'Texto', type: 'string', required: true, variables: true },
        { key: 'mode', label: 'Convertir a', type: 'dropdown', required: true, default: 'upper', options: [{ label: 'MAYÚSCULAS', value: 'upper' }, { label: 'minúsculas', value: 'lower' }, { label: 'Tipo Título', value: 'title' }] },
      ],
      async run(ctx) {
        const t = String(ctx.args.text ?? '');
        const text = ctx.args.mode === 'lower' ? t.toLowerCase() : ctx.args.mode === 'title' ? t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : t.toUpperCase();
        return { text };
      },
    },
    {
      key: 'parse-json', name: 'Leer JSON', description: 'Convierte un texto JSON en datos utilizables en los siguientes pasos.',
      arguments: [{ key: 'text', label: 'Texto JSON', type: 'text', required: true, variables: true }],
      async run(ctx) {
        const v = ctx.args.text;
        return { data: typeof v === 'string' ? JSON.parse(v) : v };
      },
    },
    {
      key: 'date', name: 'Fecha y hora actual', description: 'Fecha en distintos formatos y zona horaria.',
      arguments: [{ key: 'timeZone', label: 'Zona horaria', type: 'string', default: 'America/Mexico_City' }],
      async run(ctx) {
        const tz = String(ctx.args.timeZone || 'UTC');
        const d = new Date();
        return {
          iso: d.toISOString(),
          fecha: new Intl.DateTimeFormat('es', { timeZone: tz, dateStyle: 'full' }).format(d),
          hora: new Intl.DateTimeFormat('es', { timeZone: tz, timeStyle: 'short' }).format(d),
        };
      },
    },
  ],
} satisfies ModuleDef;
