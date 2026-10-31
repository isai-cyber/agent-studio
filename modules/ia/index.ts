// IA: texto con el LLM configurado (DeepSeek, Qwen… ver src/llm.ts) y voz con ElevenLabs.
import type { ModuleDef } from '../../src/modules/sdk.ts';

export default {
  key: 'ia',
  name: 'IA (texto y voz)',
  description: 'Genera, resume o clasifica texto con el modelo configurado (DeepSeek, Qwen…) y convierte texto en voz con ElevenLabs.',
  icon: '✨',
  color: '#f59e0b',
  category: 'IA',
  author: 'Agent Studio',
  version: '1.0.0',
  actions: [
    {
      key: 'generate', name: 'Generar texto', description: 'Resultado en {{steps.<id>.text}}.',
      arguments: [
        { key: 'prompt', label: 'Instrucción', type: 'text', required: true, variables: true, placeholder: 'Resume este mensaje en una frase: {{trigger.message}}' },
        { key: 'system', label: 'Rol (opcional)', type: 'text', variables: true, placeholder: 'Eres un asistente conciso.' },
        { key: 'temperature', label: 'Creatividad (0–1)', type: 'number', default: 0.4 },
      ],
      async run(ctx) {
        return { text: await ctx.agentStudio.llm(String(ctx.args.prompt), ctx.args.system ? String(ctx.args.system) : undefined, Number(ctx.args.temperature ?? 0.4)) };
      },
    },
    {
      key: 'classify', name: 'Clasificar texto', description: 'Elige una categoría de la lista. Resultado en {{steps.<id>.category}}.',
      arguments: [
        { key: 'text', label: 'Texto', type: 'text', required: true, variables: true },
        { key: 'categories', label: 'Categorías (separadas por coma)', type: 'string', required: true, placeholder: 'ventas, soporte, queja, otro' },
      ],
      async run(ctx) {
        const cats = String(ctx.args.categories).split(',').map((c) => c.trim()).filter(Boolean);
        const out = (await ctx.agentStudio.llm(`Clasifica el texto en UNA de estas categorías: ${cats.join(', ')}. Responde solo con la categoría.\n\nTexto: ${ctx.args.text}`, undefined, 0, 'classify')).trim().toLowerCase();
        return { category: cats.find((c) => out.includes(c.toLowerCase())) ?? out };
      },
    },
    {
      key: 'tts', name: 'Texto a voz', description: 'Crea un MP3 con ElevenLabs. URL en {{steps.<id>.url}}.',
      arguments: [
        { key: 'text', label: 'Texto', type: 'text', required: true, variables: true },
        { key: 'voiceId', label: 'ID de voz (opcional)', type: 'string' },
      ],
      async run(ctx) {
        return ctx.agentStudio.tts(String(ctx.args.text), ctx.args.voiceId ? String(ctx.args.voiceId) : undefined);
      },
    },
  ],
} satisfies ModuleDef;
