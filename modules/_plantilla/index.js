// Plantilla de módulo para la comunidad.
// Copia esta carpeta a modules-community/<tu-clave>/, cambia la clave y edita.
// Las carpetas que empiezan por "_" no se cargan. Guía completa: MODULES.md
export default {
  key: 'mi-modulo',            // único, en minúsculas y con guiones
  name: 'Mi módulo',
  description: 'Qué hace este módulo en una frase.',
  icon: '🧩',                   // un emoji
  color: '#8b5cf6',
  category: 'Comunidad',
  author: 'Tu nombre',
  version: '1.0.0',
  homepage: 'https://github.com/tu-usuario/tu-repo',

  // Disparadores: qué inicia un flujo.
  // type: 'manual' | 'webhook' | 'schedule' | 'event' | 'poll'
  triggers: [
    {
      key: 'nuevos-elementos',
      name: 'Nuevos elementos',
      type: 'poll', // el servidor llama a run() cada "everyMinutes" y dispara el flujo por cada id nuevo
      arguments: [{ key: 'everyMinutes', label: 'Comprobar cada (minutos)', type: 'number', default: 15 }],
      async run(ctx) {
        const data = await ctx.fetchJson('https://api.ejemplo.com/elementos');
        return data.map((x) => ({ id: String(x.id), ...x }));
      },
    },
  ],

  // Acciones: los pasos del flujo. Lo que devuelve run() queda en {{steps.<id-del-paso>...}}
  actions: [
    {
      key: 'saludar',
      name: 'Saludar',
      description: 'Devuelve un saludo.',
      arguments: [
        // type: 'string' | 'text' | 'number' | 'boolean' | 'dropdown' | 'json' | 'agent'
        { key: 'nombre', label: 'Nombre', type: 'string', required: true, variables: true },
      ],
      async run(ctx) {
        // ctx.args (ya con las {{variables}} sustituidas), ctx.trigger, ctx.steps,
        // ctx.env (solo FLOW_*), ctx.fetchJson(), ctx.agentStudio.{chat,llm,tts,listAgents},
        // ctx.log(), ctx.stop(motivo) para detener el flujo
        return { texto: `¡Hola, ${ctx.args.nombre}!` };
      },
    },
  ],
};
