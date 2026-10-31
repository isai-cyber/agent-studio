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
        // Con Jev es una decisión tipada (rápida y barata); si no, la toma el LLM de clasificar
        const cats = String(ctx.args.categories).split(',').map((c) => c.trim()).filter(Boolean);
        const r = await ctx.agentStudio.choose(String(ctx.args.text ?? ''), cats, 'Clasifica el texto en la categoría que mejor encaje.');
        return { category: r.choice, confianza: r.confidence, via: r.via };
      },
    },
    {
      key: 'yes-no', name: '¿Se cumple? (sí/no)', description: 'Probabilidad de que una afirmación sea cierta sobre el texto, con Jev si está configurado. Resultado en {{steps.<id>.cumple}} y {{steps.<id>.probabilidad}}.',
      arguments: [
        { key: 'text', label: 'Texto', type: 'text', required: true, variables: true, placeholder: '{{trigger.message}}' },
        { key: 'statement', label: 'Afirmación', type: 'string', required: true, placeholder: 'El cliente está enfadado' },
        { key: 'threshold', label: 'Umbral (0–1)', type: 'number', default: 0.5 },
      ],
      async run(ctx) {
        const r = await ctx.agentStudio.yesNo(String(ctx.args.text ?? ''), String(ctx.args.statement));
        return { cumple: r.probability >= Number(ctx.args.threshold ?? 0.5), probabilidad: r.probability, via: r.via };
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
