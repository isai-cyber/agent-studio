// Envío de mensajes a Telegram, Discord y Slack.
// Las credenciales van en el .env con prefijo FLOW_ (p. ej. FLOW_TELEGRAM_TOKEN) y se
// usan en los campos como {{env.FLOW_TELEGRAM_TOKEN}}.
import type { ModuleDef } from '../../src/modules/sdk.ts';

async function post(url: string, body: unknown): Promise<{ status: number; ok: boolean; data: unknown }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return { status: res.status, ok: res.ok, data };
}

export default {
  key: 'mensajeria',
  name: 'Mensajería',
  description: 'Envía mensajes a Telegram, Discord y Slack.',
  icon: '💬',
  color: '#6fa8ff',
  category: 'Comunicación',
  author: 'Agent Studio',
  version: '1.0.0',
  actions: [
    {
      key: 'telegram', name: 'Telegram: enviar mensaje',
      arguments: [
        { key: 'token', label: 'Token del bot', type: 'string', required: true, default: '{{env.FLOW_TELEGRAM_TOKEN}}', description: 'Crea el bot con @BotFather y guarda el token en FLOW_TELEGRAM_TOKEN.' },
        { key: 'chatId', label: 'Chat ID', type: 'string', required: true, variables: true },
        { key: 'text', label: 'Texto', type: 'text', required: true, variables: true },
      ],
      async run(ctx) {
        return post(`https://api.telegram.org/bot${ctx.args.token}/sendMessage`, { chat_id: ctx.args.chatId, text: ctx.args.text });
      },
    },
    {
      key: 'discord', name: 'Discord: enviar a un webhook',
      arguments: [
        { key: 'webhookUrl', label: 'URL del webhook', type: 'string', required: true, default: '{{env.FLOW_DISCORD_WEBHOOK}}' },
        { key: 'content', label: 'Mensaje', type: 'text', required: true, variables: true },
      ],
      async run(ctx) {
        await post(String(ctx.args.webhookUrl), { content: ctx.args.content });
        return { enviado: true };
      },
    },
    {
      key: 'slack', name: 'Slack: enviar a un webhook',
      arguments: [
        { key: 'webhookUrl', label: 'URL del webhook entrante', type: 'string', required: true, default: '{{env.FLOW_SLACK_WEBHOOK}}' },
        { key: 'text', label: 'Mensaje', type: 'text', required: true, variables: true },
      ],
      async run(ctx) {
        await post(String(ctx.args.webhookUrl), { text: ctx.args.text });
        return { enviado: true };
      },
    },
  ],
} satisfies ModuleDef;
