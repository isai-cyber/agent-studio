// Integración con los propios agentes de CrawStudio A.I.
import type { ModuleDef } from '../../src/modules/sdk.ts';

export default {
  key: 'agent-studio',
  name: 'Agentes',
  description: 'Dispara flujos cuando un agente responde y habla con tus agentes desde un flujo.',
  icon: '🤖',
  color: '#ff4fa3',
  category: 'CrawStudio A.I',
  author: 'CrawStudio A.I',
  version: '1.0.0',
  triggers: [
    {
      key: 'agent-turn', name: 'Un agente responde', type: 'event', event: 'agent.turn',
      description: 'Cada vez que un agente contesta. Datos: {{trigger.agentId}}, {{trigger.message}}, {{trigger.reply}}, {{trigger.topic}}, {{trigger.sessionId}}.',
      arguments: [
        { key: 'agentId', label: 'Agente (vacío = cualquiera)', type: 'agent' },
        { key: 'topic', label: 'Solo si el tema es (opcional)', type: 'string', placeholder: 'Hablar con una persona' },
      ],
    },
  ],
  actions: [
    {
      key: 'chat', name: 'Enviar mensaje a un agente', description: 'Devuelve la respuesta del agente ({{steps.<id>.reply}}).',
      arguments: [
        { key: 'agentId', label: 'Agente', type: 'agent', required: true },
        { key: 'message', label: 'Mensaje', type: 'text', required: true, variables: true },
        { key: 'sessionId', label: 'Sesión (opcional)', type: 'string', variables: true, description: 'Para continuar una conversación.' },
      ],
      async run(ctx) {
        return ctx.agentStudio.chat(String(ctx.args.agentId), String(ctx.args.message ?? ''), ctx.args.sessionId ? String(ctx.args.sessionId) : undefined);
      },
    },
  ],
} satisfies ModuleDef;
