// Catálogo de apps populares. Cada app es un conector HTTP declarativo (src/modules/http-app.ts).
// Las credenciales se guardan en el paso "Elegir conexión" de cada flujo, o en el .env como
// FLOW_<APP>_<CAMPO> (p. ej. FLOW_SLACK_TOKEN).
//
// Para añadir una app: copia una entrada parecida, revisa la documentación de su API y
// ajusta url/body. Las de OAuth (Google, Salesforce) piden un "access token" que caduca:
// para uso continuo conviene un servidor MCP del proveedor (módulo MCP) o un webhook propio.
import Anthropic from '@anthropic-ai/sdk';
import { basic, httpApp, type HttpAppDef } from '../../src/modules/http-app.ts';
import type { Argument } from '../../src/modules/sdk.ts';

const s = (key: string, label: string, extra: Partial<Argument> = {}): Argument => ({ key, label, type: 'string', variables: true, ...extra });
const t = (key: string, label: string, extra: Partial<Argument> = {}): Argument => ({ key, label, type: 'text', variables: true, ...extra });
const req = { required: true };
const bearer = (field = 'token') => (h: Record<string, string>, c: Record<string, string>) => { h.Authorization = `Bearer ${c[field]}`; };
const header = (name: string, field: string, prefix = '') => (h: Record<string, string>, c: Record<string, string>) => { h[name] = `${prefix}${c[field]}`; };
const secret = (key: string, label: string, help?: string, placeholder?: string) => ({ key, label, secret: true, help, placeholder });
const field = (key: string, label: string, help?: string, placeholder?: string) => ({ key, label, help, placeholder });
const list = (v: unknown) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const json = (v: unknown, fallback: unknown = {}) => {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { throw new Error('El campo debe ser JSON válido'); }
};

const APPS: HttpAppDef[] = [
  // ───────────── Comunicación ─────────────
  {
    key: 'slack', name: 'Slack', icon: '💬', color: '#4A154B', category: 'Comunicación', docs: 'https://api.slack.com/methods/chat.postMessage',
    description: 'Envía mensajes a canales o personas con un bot de Slack.',
    auth: { fields: [secret('token', 'Token del bot (xoxb-…)', 'Crea una app en api.slack.com/apps, añade el permiso chat:write e instálala en tu espacio.')], apply: bearer() },
    actions: [{
      key: 'send', name: 'Enviar mensaje', method: 'POST', url: 'https://slack.com/api/chat.postMessage',
      args: [s('channel', 'Canal (#general o ID)', req), t('text', 'Mensaje', req)],
      body: (a) => ({ channel: a.channel, text: a.text }),
      check: (d) => (d.ok === false ? d.error : undefined), pick: (d) => ({ ok: d.ok, ts: d.ts, channel: d.channel }),
    }],
  },
  {
    key: 'discord-bot', name: 'Discord (bot)', icon: '🎮', color: '#5865F2', category: 'Comunicación', docs: 'https://discord.com/developers/docs/resources/message#create-message',
    description: 'Publica mensajes en un canal con tu bot de Discord.',
    auth: { fields: [secret('token', 'Token del bot', 'Discord Developer Portal → tu aplicación → Bot → Reset Token.')], apply: header('Authorization', 'token', 'Bot ') },
    actions: [{
      key: 'send', name: 'Enviar mensaje a un canal', method: 'POST', url: (a) => `https://discord.com/api/v10/channels/${a.channelId}/messages`,
      args: [s('channelId', 'ID del canal', req), t('content', 'Mensaje', req)], body: (a) => ({ content: a.content }), pick: (d) => ({ id: d.id }),
    }],
  },
  {
    key: 'telegram', name: 'Telegram', icon: '✈️', color: '#26A5E4', category: 'Comunicación', docs: 'https://core.telegram.org/bots/api',
    description: 'Envía mensajes y fotos con tu bot, y reacciona a los mensajes que recibe.',
    auth: { fields: [secret('token', 'Token del bot', 'Habla con @BotFather en Telegram y usa /newbot.')] },
    actions: [
      { key: 'send', name: 'Enviar mensaje', method: 'POST', url: (_a, c) => `https://api.telegram.org/bot${c.token}/sendMessage`,
        args: [s('chatId', 'Chat ID', req), t('text', 'Mensaje', req)], body: (a) => ({ chat_id: a.chatId, text: a.text }),
        check: (d) => (d.ok === false ? d.description : undefined), pick: (d) => ({ messageId: d.result?.message_id }) },
      { key: 'photo', name: 'Enviar foto', method: 'POST', url: (_a, c) => `https://api.telegram.org/bot${c.token}/sendPhoto`,
        args: [s('chatId', 'Chat ID', req), s('photo', 'URL de la imagen', req), t('caption', 'Texto')], body: (a) => ({ chat_id: a.chatId, photo: a.photo, caption: a.caption }),
        check: (d) => (d.ok === false ? d.description : undefined) },
    ],
    triggers: [{
      key: 'new-message', name: 'Nuevo mensaje al bot', description: 'Datos: {{trigger.text}}, {{trigger.chatId}}, {{trigger.from}}. Ideal para responder con un agente.',
      url: (_a, c) => `https://api.telegram.org/bot${c.token}/getUpdates?limit=50`,
      items: (d) => (d.result ?? []).filter((u: any) => u.message).map((u: any) => ({ id: u.update_id, text: u.message.text ?? '', chatId: u.message.chat.id, from: u.message.from?.first_name ?? '', date: u.message.date })),
    }],
  },
  {
    key: 'whatsapp', name: 'WhatsApp Business', icon: '🟢', color: '#25D366', category: 'Comunicación', docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages',
    description: 'Envía mensajes de WhatsApp con la Cloud API de Meta.',
    auth: { fields: [secret('token', 'Token de acceso', 'Meta for Developers → tu app → WhatsApp → Configuración de la API.'), field('phoneNumberId', 'ID del número de teléfono')], apply: bearer() },
    actions: [{
      key: 'send', name: 'Enviar mensaje de texto', method: 'POST', url: (_a, c) => `https://graph.facebook.com/v21.0/${c.phoneNumberId}/messages`,
      args: [s('to', 'Teléfono destino (con código de país, sin +)', req), t('text', 'Mensaje', req)],
      body: (a) => ({ messaging_product: 'whatsapp', to: a.to, type: 'text', text: { body: a.text } }), pick: (d) => ({ id: d.messages?.[0]?.id }),
    }],
  },
  {
    key: 'twilio', name: 'Twilio (SMS)', icon: '📱', color: '#F22F46', category: 'Comunicación', docs: 'https://www.twilio.com/docs/messaging/api/message-resource',
    description: 'Envía SMS (o WhatsApp vía Twilio) a cualquier número.',
    auth: { fields: [field('accountSid', 'Account SID'), secret('authToken', 'Auth Token'), field('from', 'Número remitente (+1…)')], apply: (h, c) => { h.Authorization = basic(c.accountSid, c.authToken); } },
    actions: [{
      key: 'sms', name: 'Enviar SMS', method: 'POST', encoding: 'form', url: (_a, c) => `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`,
      args: [s('to', 'Teléfono destino (+52…)', req), t('body', 'Mensaje', req)], body: (a, c) => ({ To: a.to, From: c.from, Body: a.body }), pick: (d) => ({ sid: d.sid, status: d.status }),
    }],
  },
  {
    key: 'teams', name: 'Microsoft Teams', icon: '🟣', color: '#6264A7', category: 'Comunicación', docs: 'https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
    description: 'Publica en un canal de Teams mediante un webhook entrante.',
    actions: [{ key: 'send', name: 'Enviar mensaje (webhook)', method: 'POST', url: (a) => a.webhookUrl, args: [s('webhookUrl', 'URL del webhook', req), t('text', 'Mensaje', req)], body: (a) => ({ text: a.text }) }],
  },
  {
    key: 'google-chat', name: 'Google Chat', icon: '🗨️', color: '#00AC47', category: 'Comunicación', docs: 'https://developers.google.com/workspace/chat/quickstart/webhooks',
    description: 'Publica en un espacio de Google Chat con un webhook.',
    actions: [{ key: 'send', name: 'Enviar mensaje (webhook)', method: 'POST', url: (a) => a.webhookUrl, args: [s('webhookUrl', 'URL del webhook', req), t('text', 'Mensaje', req)], body: (a) => ({ text: a.text }) }],
  },
  {
    key: 'mattermost', name: 'Mattermost', icon: '🔷', color: '#0058CC', category: 'Comunicación', docs: 'https://developers.mattermost.com/integrate/webhooks/incoming/',
    description: 'Publica en Mattermost (o Rocket.Chat) con un webhook entrante.',
    actions: [{ key: 'send', name: 'Enviar mensaje (webhook)', method: 'POST', url: (a) => a.webhookUrl, args: [s('webhookUrl', 'URL del webhook', req), t('text', 'Mensaje', req)], body: (a) => ({ text: a.text }) }],
  },
  {
    key: 'ntfy', name: 'ntfy (notificaciones push)', icon: '🔔', color: '#338574', category: 'Comunicación', docs: 'https://docs.ntfy.sh/publish/',
    description: 'Notificaciones push gratis al móvil o escritorio, sin cuenta.',
    actions: [{
      key: 'push', name: 'Enviar notificación', method: 'POST', encoding: 'text', url: (a) => `${a.server || 'https://ntfy.sh'}/${encodeURIComponent(a.topic)}`,
      args: [s('topic', 'Tema (elige un nombre difícil de adivinar)', req), t('message', 'Mensaje', req), s('title', 'Título'), s('server', 'Servidor', { default: 'https://ntfy.sh' })],
      headers: (a) => (a.title ? { Title: String(a.title) } : {}), body: (a) => a.message, pick: (d) => ({ id: d.id, topic: d.topic }),
    }],
  },
  {
    key: 'pushover', name: 'Pushover', icon: '📣', color: '#249DF1', category: 'Comunicación', docs: 'https://pushover.net/api',
    description: 'Notificaciones push a tus dispositivos.',
    auth: { fields: [secret('token', 'Token de la aplicación'), field('user', 'Clave de usuario')] },
    actions: [{ key: 'push', name: 'Enviar notificación', method: 'POST', encoding: 'form', url: 'https://api.pushover.net/1/messages.json',
      args: [t('message', 'Mensaje', req), s('title', 'Título')], body: (a, c) => ({ token: c.token, user: c.user, message: a.message, title: a.title }) }],
  },

  // ───────────── Email y marketing ─────────────
  {
    key: 'gmail', name: 'Gmail', icon: '📧', color: '#EA4335', category: 'Email', docs: 'https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send',
    description: 'Envía correos desde tu cuenta de Gmail.',
    auth: { fields: [secret('accessToken', 'Access token OAuth (scope gmail.send)', 'Caduca en ~1 h. Para uso continuo usa el servidor MCP de Google o Resend/SendGrid.')], apply: bearer('accessToken') },
    actions: [{
      key: 'send', name: 'Enviar correo', method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      args: [s('to', 'Para', req), s('subject', 'Asunto', req), t('body', 'Texto', req)],
      body: (a) => ({ raw: Buffer.from(`To: ${a.to}\r\nSubject: =?UTF-8?B?${Buffer.from(String(a.subject)).toString('base64')}?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.body}`).toString('base64url') }),
      pick: (d) => ({ id: d.id }),
    }],
  },
  {
    key: 'resend', name: 'Resend', icon: '✉️', color: '#000000', category: 'Email', docs: 'https://resend.com/docs/api-reference/emails/send-email',
    description: 'Envío de correos transaccionales sencillo.',
    auth: { fields: [secret('apiKey', 'API key (re_…)')], apply: bearer('apiKey') },
    actions: [{ key: 'send', name: 'Enviar correo', method: 'POST', url: 'https://api.resend.com/emails',
      args: [s('from', 'De (dominio verificado)', req), s('to', 'Para (varios separados por coma)', req), s('subject', 'Asunto', req), t('html', 'Contenido (HTML o texto)', req)],
      body: (a) => ({ from: a.from, to: list(a.to), subject: a.subject, html: a.html }), pick: (d) => ({ id: d.id }) }],
  },
  {
    key: 'sendgrid', name: 'SendGrid', icon: '📨', color: '#1A82E2', category: 'Email', docs: 'https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send',
    description: 'Envío de correos con Twilio SendGrid.',
    auth: { fields: [secret('apiKey', 'API key (SG.…)')], apply: bearer('apiKey') },
    actions: [{ key: 'send', name: 'Enviar correo', method: 'POST', url: 'https://api.sendgrid.com/v3/mail/send',
      args: [s('from', 'De (remitente verificado)', req), s('to', 'Para', req), s('subject', 'Asunto', req), t('text', 'Texto', req)],
      body: (a) => ({ personalizations: [{ to: list(a.to).map((email) => ({ email })) }], from: { email: a.from }, subject: a.subject, content: [{ type: 'text/plain', value: a.text }] }),
      pick: () => ({ enviado: true }) }],
  },
  {
    key: 'mailgun', name: 'Mailgun', icon: '📮', color: '#F06B66', category: 'Email', docs: 'https://documentation.mailgun.com/docs/mailgun/api-reference/',
    description: 'Envío de correos con Mailgun.',
    auth: { fields: [secret('apiKey', 'API key'), field('domain', 'Dominio (mg.tudominio.com)'), field('region', 'Región (us o eu)', undefined, 'us')], apply: (h, c) => { h.Authorization = basic('api', c.apiKey); } },
    actions: [{ key: 'send', name: 'Enviar correo', method: 'POST', encoding: 'form',
      url: (_a, c) => `https://${c.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'}/v3/${c.domain}/messages`,
      args: [s('from', 'De', req), s('to', 'Para', req), s('subject', 'Asunto', req), t('text', 'Texto', req)], body: (a) => ({ from: a.from, to: a.to, subject: a.subject, text: a.text }) }],
  },
  {
    key: 'postmark', name: 'Postmark', icon: '📬', color: '#FFDE00', category: 'Email', docs: 'https://postmarkapp.com/developer/api/email-api',
    description: 'Correos transaccionales con alta entregabilidad.',
    auth: { fields: [secret('serverToken', 'Server API token')], apply: header('X-Postmark-Server-Token', 'serverToken') },
    actions: [{ key: 'send', name: 'Enviar correo', method: 'POST', url: 'https://api.postmarkapp.com/email',
      args: [s('from', 'De', req), s('to', 'Para', req), s('subject', 'Asunto', req), t('text', 'Texto', req)],
      body: (a) => ({ From: a.from, To: a.to, Subject: a.subject, TextBody: a.text }), pick: (d) => ({ id: d.MessageID }) }],
  },
  {
    key: 'brevo', name: 'Brevo', icon: '💌', color: '#0B996E', category: 'Email', docs: 'https://developers.brevo.com/reference/sendtransacemail',
    description: 'Correos transaccionales y contactos (antes Sendinblue).',
    auth: { fields: [secret('apiKey', 'API key')], apply: header('api-key', 'apiKey') },
    actions: [
      { key: 'send', name: 'Enviar correo', method: 'POST', url: 'https://api.brevo.com/v3/smtp/email',
        args: [s('from', 'De', req), s('to', 'Para', req), s('subject', 'Asunto', req), t('text', 'Texto', req)],
        body: (a) => ({ sender: { email: a.from }, to: [{ email: a.to }], subject: a.subject, textContent: a.text }), pick: (d) => ({ id: d.messageId }) },
      { key: 'contact', name: 'Crear contacto', method: 'POST', url: 'https://api.brevo.com/v3/contacts',
        args: [s('email', 'Email', req), s('listIds', 'IDs de listas (separados por coma)')], body: (a) => ({ email: a.email, listIds: list(a.listIds).map(Number), updateEnabled: true }) },
    ],
  },
  {
    key: 'mailchimp', name: 'Mailchimp', icon: '🐵', color: '#FFE01B', category: 'Email', docs: 'https://mailchimp.com/developer/marketing/api/list-members/',
    description: 'Añade suscriptores a tus audiencias.',
    auth: { fields: [secret('apiKey', 'API key (termina en -us1, -us21…)')], apply: (h, c) => { h.Authorization = basic('anystring', c.apiKey); } },
    actions: [{ key: 'subscribe', name: 'Añadir suscriptor', method: 'POST',
      url: (a, c) => `https://${String(c.apiKey).split('-').pop()}.api.mailchimp.com/3.0/lists/${a.listId}/members`,
      args: [s('listId', 'ID de la audiencia', req), s('email', 'Email', req), s('firstName', 'Nombre')],
      body: (a) => ({ email_address: a.email, status: 'subscribed', merge_fields: a.firstName ? { FNAME: a.firstName } : {} }), pick: (d) => ({ id: d.id, status: d.status }) }],
  },

  // ───────────── Productividad ─────────────
  {
    key: 'notion', name: 'Notion', icon: '📝', color: '#000000', category: 'Productividad', docs: 'https://developers.notion.com/reference/post-page',
    description: 'Crea páginas en bases de datos y reacciona a páginas nuevas.',
    auth: { fields: [secret('token', 'Token de integración interna (ntn_…)', 'notion.so/my-integrations → nueva integración. Después comparte la base de datos con ella.')], apply: bearer() },
    actions: [{
      key: 'create-page', name: 'Crear página en una base de datos', method: 'POST', url: 'https://api.notion.com/v1/pages',
      headers: () => ({ 'Notion-Version': '2022-06-28' }),
      args: [s('databaseId', 'ID de la base de datos', req), s('title', 'Título', req), s('titleProperty', 'Nombre de la columna título', { default: 'Name' }), t('content', 'Contenido')],
      body: (a) => ({
        parent: { database_id: a.databaseId },
        properties: { [a.titleProperty || 'Name']: { title: [{ text: { content: String(a.title) } }] } },
        children: a.content ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(a.content).slice(0, 2000) } }] } }] : [],
      }),
      pick: (d) => ({ id: d.id, url: d.url }),
    }],
    triggers: [{
      key: 'new-page', name: 'Nueva página en una base de datos', method: 'POST', url: (a) => `https://api.notion.com/v1/databases/${a.databaseId}/query`,
      headers: () => ({ 'Notion-Version': '2022-06-28' }), args: [s('databaseId', 'ID de la base de datos', req)],
      body: () => ({ page_size: 20, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }),
      items: (d) => (d.results ?? []).map((p: any) => ({ id: p.id, url: p.url, created: p.created_time, properties: p.properties })),
    }],
  },
  {
    key: 'airtable', name: 'Airtable', icon: '🗂️', color: '#18BFFF', category: 'Productividad', docs: 'https://airtable.com/developers/web/api/create-records',
    description: 'Crea y lee registros de tus bases.',
    auth: { fields: [secret('token', 'Personal access token (pat…)')], apply: bearer() },
    actions: [
      { key: 'create', name: 'Crear registro', method: 'POST', url: (a) => `https://api.airtable.com/v0/${a.baseId}/${encodeURIComponent(a.table)}`,
        args: [s('baseId', 'ID de la base (app…)', req), s('table', 'Tabla', req), { key: 'fields', label: 'Campos (JSON)', type: 'json', required: true, variables: true, default: '{\n  "Nombre": "{{trigger.body.nombre}}"\n}' }],
        body: (a) => ({ fields: json(a.fields) }), pick: (d) => ({ id: d.id, fields: d.fields }) },
      { key: 'list', name: 'Buscar registros', url: (a) => `https://api.airtable.com/v0/${a.baseId}/${encodeURIComponent(a.table)}`,
        query: (a) => ({ maxRecords: a.max || 20, filterByFormula: a.formula }),
        args: [s('baseId', 'ID de la base', req), s('table', 'Tabla', req), s('formula', 'Fórmula de filtro (opcional)', { placeholder: "{Estado}='Nuevo'" }), { key: 'max', label: 'Máximo', type: 'number', default: 20 }],
        pick: (d) => ({ records: d.records, total: d.records?.length ?? 0 }) },
    ],
    triggers: [{ key: 'new-record', name: 'Nuevo registro', url: (a) => `https://api.airtable.com/v0/${a.baseId}/${encodeURIComponent(a.table)}?maxRecords=50`,
      args: [s('baseId', 'ID de la base', req), s('table', 'Tabla', req)], items: (d) => (d.records ?? []).map((r: any) => ({ id: r.id, ...r.fields, createdTime: r.createdTime })) }],
  },
  {
    key: 'google-sheets', name: 'Google Sheets', icon: '📊', color: '#0F9D58', category: 'Productividad', docs: 'https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/append',
    description: 'Añade filas y lee rangos de tus hojas de cálculo.',
    auth: { fields: [secret('accessToken', 'Access token OAuth (scope spreadsheets)', 'Caduca en ~1 h. Alternativa estable: un webhook de Apps Script o el servidor MCP de Google.')], apply: bearer('accessToken') },
    actions: [
      { key: 'append', name: 'Añadir fila', method: 'POST',
        url: (a) => `https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range || 'A1')}:append?valueInputOption=USER_ENTERED`,
        args: [s('spreadsheetId', 'ID de la hoja (está en la URL)', req), s('range', 'Hoja/rango', { default: 'Hoja1!A1' }), s('values', 'Valores (separados por |)', { required: true, placeholder: '{{trigger.body.nombre}} | {{trigger.body.email}}' })],
        body: (a) => ({ values: [String(a.values).split('|').map((x) => x.trim())] }), pick: (d) => ({ rango: d.updates?.updatedRange }) },
      { key: 'read', name: 'Leer rango', url: (a) => `https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}`,
        args: [s('spreadsheetId', 'ID de la hoja', req), s('range', 'Rango', { required: true, default: 'Hoja1!A1:E50' })], pick: (d) => ({ filas: d.values ?? [] }) },
    ],
  },
  {
    key: 'google-calendar', name: 'Google Calendar', icon: '📅', color: '#4285F4', category: 'Productividad', docs: 'https://developers.google.com/calendar/api/v3/reference/events/insert',
    description: 'Crea eventos en tu calendario.',
    auth: { fields: [secret('accessToken', 'Access token OAuth (scope calendar.events)', 'Caduca en ~1 h.')], apply: bearer('accessToken') },
    actions: [{ key: 'create-event', name: 'Crear evento', method: 'POST', url: (a) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(a.calendarId || 'primary')}/events`,
      args: [s('summary', 'Título', req), s('start', 'Inicio (2026-11-03T10:00:00-06:00)', req), s('end', 'Fin', req), t('description', 'Descripción'), s('calendarId', 'Calendario', { default: 'primary' })],
      body: (a) => ({ summary: a.summary, description: a.description, start: { dateTime: a.start }, end: { dateTime: a.end } }), pick: (d) => ({ id: d.id, url: d.htmlLink }) }],
  },
  {
    key: 'todoist', name: 'Todoist', icon: '✅', color: '#E44332', category: 'Productividad', docs: 'https://developer.todoist.com/rest/v2/#create-a-new-task',
    description: 'Crea tareas en Todoist.',
    auth: { fields: [secret('token', 'Token de API', 'Configuración → Integraciones → Desarrollador.')], apply: bearer() },
    actions: [{ key: 'task', name: 'Crear tarea', method: 'POST', url: 'https://api.todoist.com/rest/v2/tasks',
      args: [s('content', 'Tarea', req), t('description', 'Descripción'), s('due', 'Fecha (en lenguaje natural)', { placeholder: 'mañana a las 9' })],
      body: (a) => ({ content: a.content, description: a.description, due_string: a.due, due_lang: 'es' }), pick: (d) => ({ id: d.id, url: d.url }) }],
  },
  {
    key: 'trello', name: 'Trello', icon: '📋', color: '#0079BF', category: 'Productividad', docs: 'https://developer.atlassian.com/cloud/trello/rest/api-group-cards/#api-cards-post',
    description: 'Crea tarjetas en tus tableros.',
    auth: { fields: [field('key', 'API key'), secret('token', 'Token')] },
    actions: [{ key: 'card', name: 'Crear tarjeta', method: 'POST', url: 'https://api.trello.com/1/cards',
      query: (a, c) => ({ idList: a.listId, name: a.name, desc: a.desc, key: c.key, token: c.token }),
      args: [s('listId', 'ID de la lista', req), s('name', 'Título', req), t('desc', 'Descripción')], pick: (d) => ({ id: d.id, url: d.shortUrl }) }],
  },
  {
    key: 'asana', name: 'Asana', icon: '🎯', color: '#F06A6A', category: 'Productividad', docs: 'https://developers.asana.com/reference/createtask',
    description: 'Crea tareas en tus proyectos.',
    auth: { fields: [secret('token', 'Personal access token')], apply: bearer() },
    actions: [{ key: 'task', name: 'Crear tarea', method: 'POST', url: 'https://app.asana.com/api/1.0/tasks',
      args: [s('projectId', 'ID del proyecto', req), s('name', 'Tarea', req), t('notes', 'Notas')],
      body: (a) => ({ data: { name: a.name, notes: a.notes, projects: [a.projectId] } }), pick: (d) => ({ id: d.data?.gid, url: d.data?.permalink_url }) }],
  },
  {
    key: 'clickup', name: 'ClickUp', icon: '🟪', color: '#7B68EE', category: 'Productividad', docs: 'https://developer.clickup.com/reference/createtask',
    description: 'Crea tareas en tus listas.',
    auth: { fields: [secret('token', 'Token personal (pk_…)')], apply: header('Authorization', 'token') },
    actions: [{ key: 'task', name: 'Crear tarea', method: 'POST', url: (a) => `https://api.clickup.com/api/v2/list/${a.listId}/task`,
      args: [s('listId', 'ID de la lista', req), s('name', 'Tarea', req), t('description', 'Descripción')], body: (a) => ({ name: a.name, description: a.description }), pick: (d) => ({ id: d.id, url: d.url }) }],
  },
  {
    key: 'monday', name: 'monday.com', icon: '🟥', color: '#FF3D57', category: 'Productividad', docs: 'https://developer.monday.com/api-reference/reference/items#create-an-item',
    description: 'Crea elementos en tus tableros.',
    auth: { fields: [secret('token', 'Token de API')], apply: header('Authorization', 'token') },
    actions: [{ key: 'item', name: 'Crear elemento', method: 'POST', url: 'https://api.monday.com/v2',
      args: [s('boardId', 'ID del tablero', req), s('name', 'Nombre', req)],
      body: (a) => ({ query: 'mutation ($board: ID!, $name: String!) { create_item (board_id: $board, item_name: $name) { id } }', variables: { board: a.boardId, name: a.name } }),
      check: (d) => d.errors?.[0]?.message, pick: (d) => ({ id: d.data?.create_item?.id }) }],
  },
  {
    key: 'jira', name: 'Jira', icon: '🔵', color: '#0052CC', category: 'Productividad', docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post',
    description: 'Crea incidencias en tus proyectos de Jira Cloud.',
    auth: { fields: [field('site', 'Sitio (tuempresa.atlassian.net)'), field('email', 'Email de la cuenta'), secret('apiToken', 'API token', 'id.atlassian.com → Seguridad → Tokens de API.')], apply: (h, c) => { h.Authorization = basic(c.email, c.apiToken); } },
    actions: [{ key: 'issue', name: 'Crear incidencia', method: 'POST', url: (_a, c) => `https://${c.site}/rest/api/3/issue`,
      args: [s('project', 'Clave del proyecto (ABC)', req), s('summary', 'Resumen', req), t('description', 'Descripción'), s('type', 'Tipo', { default: 'Task' })],
      body: (a) => ({ fields: { project: { key: a.project }, summary: a.summary, issuetype: { name: a.type || 'Task' },
        ...(a.description ? { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(a.description) }] }] } } : {}) } }),
      pick: (d) => ({ id: d.id, key: d.key }) }],
  },
  {
    key: 'linear', name: 'Linear', icon: '📐', color: '#5E6AD2', category: 'Productividad', docs: 'https://linear.app/developers/graphql',
    description: 'Crea incidencias en tus equipos de Linear.',
    auth: { fields: [secret('apiKey', 'API key personal (lin_api_…)')], apply: header('Authorization', 'apiKey') },
    actions: [{ key: 'issue', name: 'Crear incidencia', method: 'POST', url: 'https://api.linear.app/graphql',
      args: [s('teamId', 'ID del equipo', req), s('title', 'Título', req), t('description', 'Descripción')],
      body: (a) => ({ query: 'mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', variables: { input: { teamId: a.teamId, title: a.title, description: a.description } } }),
      check: (d) => d.errors?.[0]?.message, pick: (d) => d.data?.issueCreate?.issue }],
  },

  // ───────────── Desarrollo y datos ─────────────
  {
    key: 'github', name: 'GitHub', icon: '🐙', color: '#24292F', category: 'Desarrollo', docs: 'https://docs.github.com/rest/issues/issues#create-an-issue',
    description: 'Crea incidencias y reacciona a incidencias nuevas.',
    auth: { fields: [secret('token', 'Token (fine-grained, permiso Issues)')], apply: bearer() },
    actions: [{ key: 'issue', name: 'Crear incidencia', method: 'POST', url: (a) => `https://api.github.com/repos/${a.owner}/${a.repo}/issues`,
      headers: () => ({ Accept: 'application/vnd.github+json' }),
      args: [s('owner', 'Propietario', req), s('repo', 'Repositorio', req), s('title', 'Título', req), t('body', 'Descripción'), s('labels', 'Etiquetas (separadas por coma)')],
      body: (a) => ({ title: a.title, body: a.body, labels: list(a.labels) }), pick: (d) => ({ number: d.number, url: d.html_url }) }],
    triggers: [{ key: 'new-issue', name: 'Nueva incidencia', url: (a) => `https://api.github.com/repos/${a.owner}/${a.repo}/issues?state=open&sort=created&direction=desc&per_page=20`,
      headers: () => ({ Accept: 'application/vnd.github+json' }), args: [s('owner', 'Propietario', req), s('repo', 'Repositorio', req)],
      items: (d) => (Array.isArray(d) ? d : []).filter((i: any) => !i.pull_request).map((i: any) => ({ id: i.id, number: i.number, title: i.title, body: i.body, url: i.html_url, user: i.user?.login })) }],
  },
  {
    key: 'gitlab', name: 'GitLab', icon: '🦊', color: '#FC6D26', category: 'Desarrollo', docs: 'https://docs.gitlab.com/api/issues/#new-issue',
    description: 'Crea incidencias en tus proyectos.',
    auth: { fields: [secret('token', 'Personal access token'), field('baseUrl', 'URL de GitLab', undefined, 'https://gitlab.com')], apply: header('PRIVATE-TOKEN', 'token') },
    actions: [{ key: 'issue', name: 'Crear incidencia', method: 'POST', url: (a, c) => `${c.baseUrl || 'https://gitlab.com'}/api/v4/projects/${encodeURIComponent(a.project)}/issues`,
      args: [s('project', 'Proyecto (ID o grupo/proyecto)', req), s('title', 'Título', req), t('description', 'Descripción')], body: (a) => ({ title: a.title, description: a.description }), pick: (d) => ({ iid: d.iid, url: d.web_url }) }],
  },
  {
    key: 'supabase', name: 'Supabase', icon: '⚡', color: '#3ECF8E', category: 'Desarrollo', docs: 'https://supabase.com/docs/guides/api',
    description: 'Inserta y consulta filas de tu base de datos Postgres.',
    auth: { fields: [field('url', 'URL del proyecto (https://xxx.supabase.co)'), secret('key', 'API key (service_role o anon)')], apply: (h, c) => { h.apikey = c.key; h.Authorization = `Bearer ${c.key}`; } },
    actions: [
      { key: 'insert', name: 'Insertar fila', method: 'POST', url: (a, c) => `${c.url}/rest/v1/${a.table}`, headers: () => ({ Prefer: 'return=representation' }),
        args: [s('table', 'Tabla', req), { key: 'row', label: 'Fila (JSON)', type: 'json', required: true, variables: true, default: '{\n  "nombre": "{{trigger.body.nombre}}"\n}' }],
        body: (a) => json(a.row), pick: (d) => ({ filas: d }) },
      { key: 'select', name: 'Consultar filas', url: (a, c) => `${c.url}/rest/v1/${a.table}?${a.filter || 'select=*'}&limit=${a.limit || 20}`,
        args: [s('table', 'Tabla', req), s('filter', 'Filtro PostgREST', { default: 'select=*', placeholder: 'select=*&estado=eq.nuevo' }), { key: 'limit', label: 'Límite', type: 'number', default: 20 }],
        pick: (d) => ({ filas: d, total: Array.isArray(d) ? d.length : 0 }) },
    ],
  },
  {
    key: 'rss', name: 'RSS / Atom', icon: '📰', color: '#F26522', category: 'Desarrollo',
    description: 'Dispara el flujo con cada entrada nueva de un feed (blogs, noticias, YouTube, podcasts).',
    triggers: [{
      key: 'new-item', name: 'Nueva entrada en el feed', url: (a) => a.url, args: [s('url', 'URL del feed', { required: true, placeholder: 'https://hnrss.org/frontpage' })],
      items: (xml) => {
        const text = String(xml);
        const tag = (block: string, name: string) => (block.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, 'i'))?.[1] ?? '').trim();
        const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
        return blocks.slice(0, 30).map((b) => {
          const link = tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '');
          return { id: tag(b, 'guid') || tag(b, 'id') || link, title: tag(b, 'title'), link, date: tag(b, 'pubDate') || tag(b, 'updated'), summary: tag(b, 'description').replace(/<[^>]+>/g, '').slice(0, 500) };
        });
      },
    }],
  },

  // ───────────── CRM y atención al cliente ─────────────
  {
    key: 'hubspot', name: 'HubSpot', icon: '🧡', color: '#FF7A59', category: 'CRM', docs: 'https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide',
    description: 'Crea contactos y reacciona a contactos nuevos en tu CRM.',
    auth: { fields: [secret('token', 'Token de app privada (pat-…)', 'HubSpot → Configuración → Integraciones → Apps privadas.')], apply: bearer() },
    actions: [{ key: 'contact', name: 'Crear contacto', method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/contacts',
      args: [s('email', 'Email', req), s('firstname', 'Nombre'), s('lastname', 'Apellido'), s('phone', 'Teléfono')],
      body: (a) => ({ properties: Object.fromEntries(Object.entries({ email: a.email, firstname: a.firstname, lastname: a.lastname, phone: a.phone }).filter(([, v]) => v)) }),
      pick: (d) => ({ id: d.id }) }],
    triggers: [{ key: 'new-contact', name: 'Nuevo contacto', method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/contacts/search',
      body: () => ({ sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }], limit: 20, properties: ['email', 'firstname', 'lastname', 'phone'] }),
      items: (d) => (d.results ?? []).map((r: any) => ({ id: r.id, ...r.properties })) }],
  },
  {
    key: 'pipedrive', name: 'Pipedrive', icon: '🟩', color: '#017737', category: 'CRM', docs: 'https://developers.pipedrive.com/docs/api/v1',
    description: 'Crea personas y tratos en tu embudo de ventas.',
    auth: { fields: [secret('apiToken', 'API token')] },
    actions: [
      { key: 'person', name: 'Crear persona', method: 'POST', url: 'https://api.pipedrive.com/v1/persons', query: (_a, c) => ({ api_token: c.apiToken }),
        args: [s('name', 'Nombre', req), s('email', 'Email'), s('phone', 'Teléfono')], body: (a) => ({ name: a.name, email: a.email ? [a.email] : undefined, phone: a.phone ? [a.phone] : undefined }), pick: (d) => ({ id: d.data?.id }) },
      { key: 'deal', name: 'Crear trato', method: 'POST', url: 'https://api.pipedrive.com/v1/deals', query: (_a, c) => ({ api_token: c.apiToken }),
        args: [s('title', 'Título', req), { key: 'value', label: 'Valor', type: 'number', variables: true }, s('currency', 'Moneda', { default: 'USD' })],
        body: (a) => ({ title: a.title, value: a.value ? Number(a.value) : undefined, currency: a.currency }), pick: (d) => ({ id: d.data?.id }) },
    ],
  },
  {
    key: 'salesforce', name: 'Salesforce', icon: '☁️', color: '#00A1E0', category: 'CRM', docs: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_sobject_create.htm',
    description: 'Crea leads en Salesforce.',
    auth: { fields: [field('instanceUrl', 'URL de la instancia (https://tuempresa.my.salesforce.com)'), secret('accessToken', 'Access token OAuth')], apply: bearer('accessToken') },
    actions: [{ key: 'lead', name: 'Crear lead', method: 'POST', url: (_a, c) => `${c.instanceUrl}/services/data/v60.0/sobjects/Lead`,
      args: [s('lastName', 'Apellido', req), s('company', 'Empresa', req), s('email', 'Email'), s('firstName', 'Nombre')],
      body: (a) => ({ LastName: a.lastName, Company: a.company, Email: a.email, FirstName: a.firstName }), pick: (d) => ({ id: d.id }) }],
  },
  {
    key: 'zendesk', name: 'Zendesk', icon: '🎫', color: '#03363D', category: 'CRM', docs: 'https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/#create-ticket',
    description: 'Crea tickets de soporte (por ejemplo, cuando un agente escala).',
    auth: { fields: [field('subdomain', 'Subdominio (tuempresa)'), field('email', 'Email del agente'), secret('apiToken', 'API token')], apply: (h, c) => { h.Authorization = basic(`${c.email}/token`, c.apiToken); } },
    actions: [{ key: 'ticket', name: 'Crear ticket', method: 'POST', url: (_a, c) => `https://${c.subdomain}.zendesk.com/api/v2/tickets.json`,
      args: [s('subject', 'Asunto', req), t('body', 'Descripción', req), s('requesterEmail', 'Email del cliente'), s('requesterName', 'Nombre del cliente')],
      body: (a) => ({ ticket: { subject: a.subject, comment: { body: a.body }, ...(a.requesterEmail ? { requester: { email: a.requesterEmail, name: a.requesterName || a.requesterEmail } } : {}) } }),
      pick: (d) => ({ id: d.ticket?.id }) }],
  },
  {
    key: 'freshdesk', name: 'Freshdesk', icon: '🍃', color: '#25C16F', category: 'CRM', docs: 'https://developers.freshdesk.com/api/#create_ticket',
    description: 'Crea tickets de soporte.',
    auth: { fields: [field('domain', 'Dominio (tuempresa)'), secret('apiKey', 'API key')], apply: (h, c) => { h.Authorization = basic(c.apiKey, 'X'); } },
    actions: [{ key: 'ticket', name: 'Crear ticket', method: 'POST', url: (_a, c) => `https://${c.domain}.freshdesk.com/api/v2/tickets`,
      args: [s('subject', 'Asunto', req), t('description', 'Descripción', req), s('email', 'Email del cliente', req)],
      body: (a) => ({ subject: a.subject, description: a.description, email: a.email, priority: 1, status: 2 }), pick: (d) => ({ id: d.id }) }],
  },
  {
    key: 'intercom', name: 'Intercom', icon: '💭', color: '#1F8DED', category: 'CRM', docs: 'https://developers.intercom.com/docs/references/rest-api/api.intercom.io/contacts/createcontact',
    description: 'Crea contactos en Intercom.',
    auth: { fields: [secret('token', 'Access token')], apply: bearer() },
    actions: [{ key: 'contact', name: 'Crear contacto', method: 'POST', url: 'https://api.intercom.io/contacts',
      args: [s('email', 'Email', req), s('name', 'Nombre')], body: (a) => ({ role: 'user', email: a.email, name: a.name }), pick: (d) => ({ id: d.id }) }],
  },

  // ───────────── Comercio y pagos ─────────────
  {
    key: 'stripe', name: 'Stripe', icon: '💳', color: '#635BFF', category: 'Comercio', docs: 'https://docs.stripe.com/api',
    description: 'Crea clientes y reacciona a pagos nuevos.',
    auth: { fields: [secret('secretKey', 'Clave secreta (sk_…; usa una restringida si puedes)')], apply: bearer('secretKey') },
    actions: [{ key: 'customer', name: 'Crear cliente', method: 'POST', encoding: 'form', url: 'https://api.stripe.com/v1/customers',
      args: [s('email', 'Email', req), s('name', 'Nombre')], body: (a) => ({ email: a.email, name: a.name }), pick: (d) => ({ id: d.id }) }],
    triggers: [{ key: 'new-charge', name: 'Nuevo pago', url: 'https://api.stripe.com/v1/charges?limit=20',
      items: (d) => (d.data ?? []).map((c: any) => ({ id: c.id, amount: c.amount / 100, currency: c.currency, status: c.status, email: c.billing_details?.email, description: c.description })) }],
  },
  {
    key: 'shopify', name: 'Shopify', icon: '🛍️', color: '#95BF47', category: 'Comercio', docs: 'https://shopify.dev/docs/api/admin-rest',
    description: 'Reacciona a pedidos nuevos y consulta pedidos.',
    auth: { fields: [field('shop', 'Tienda (tutienda.myshopify.com)'), secret('accessToken', 'Admin API access token (shpat_…)')], apply: header('X-Shopify-Access-Token', 'accessToken') },
    actions: [{ key: 'find-order', name: 'Buscar pedido por número', url: (a, c) => `https://${c.shop}/admin/api/2024-10/orders.json?status=any&name=${encodeURIComponent('#' + String(a.number).replace('#', ''))}`,
      args: [s('number', 'Número de pedido', req)], pick: (d) => ({ pedido: d.orders?.[0] ?? null, encontrado: Boolean(d.orders?.length) }) }],
    triggers: [{ key: 'new-order', name: 'Nuevo pedido', url: (_a, c) => `https://${c.shop}/admin/api/2024-10/orders.json?status=any&limit=20`,
      items: (d) => (d.orders ?? []).map((o: any) => ({ id: o.id, name: o.name, total: o.total_price, currency: o.currency, email: o.email, customer: `${o.customer?.first_name ?? ''} ${o.customer?.last_name ?? ''}`.trim() })) }],
  },
  {
    key: 'woocommerce', name: 'WooCommerce', icon: '🟪', color: '#96588A', category: 'Comercio', docs: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    description: 'Reacciona a pedidos nuevos y cambia su estado.',
    auth: { fields: [field('siteUrl', 'URL de la tienda (https://…)'), field('consumerKey', 'Consumer key (ck_…)'), secret('consumerSecret', 'Consumer secret (cs_…)')], apply: (h, c) => { h.Authorization = basic(c.consumerKey, c.consumerSecret); } },
    actions: [{ key: 'update-status', name: 'Cambiar estado del pedido', method: 'PUT', url: (a, c) => `${c.siteUrl}/wp-json/wc/v3/orders/${a.orderId}`,
      args: [s('orderId', 'ID del pedido', req), { key: 'status', label: 'Estado', type: 'dropdown', required: true, default: 'processing', options: ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded'].map((v) => ({ label: v, value: v })) }],
      body: (a) => ({ status: a.status }), pick: (d) => ({ id: d.id, status: d.status }) }],
    triggers: [{ key: 'new-order', name: 'Nuevo pedido', url: (_a, c) => `${c.siteUrl}/wp-json/wc/v3/orders?per_page=20`,
      items: (d) => (Array.isArray(d) ? d : []).map((o: any) => ({ id: o.id, number: o.number, status: o.status, total: o.total, currency: o.currency, email: o.billing?.email })) }],
  },
  {
    key: 'mercadopago', name: 'Mercado Pago', icon: '💙', color: '#00B1EA', category: 'Comercio', docs: 'https://www.mercadopago.com/developers/es/reference/preferences/_checkout_preferences/post',
    description: 'Genera enlaces de pago (muy usado en Latinoamérica).',
    auth: { fields: [secret('accessToken', 'Access token (APP_USR-… o TEST-…)')], apply: bearer('accessToken') },
    actions: [{ key: 'payment-link', name: 'Crear enlace de pago', method: 'POST', url: 'https://api.mercadopago.com/checkout/preferences',
      args: [s('title', 'Concepto', req), { key: 'price', label: 'Precio', type: 'number', required: true, variables: true }, s('currency', 'Moneda', { default: 'MXN' })],
      body: (a) => ({ items: [{ title: a.title, quantity: 1, unit_price: Number(a.price), currency_id: a.currency || 'MXN' }] }), pick: (d) => ({ id: d.id, link: d.init_point }) }],
  },

  {
    key: 'facturama', name: 'Facturama (CFDI)', icon: '🧾', color: '#0A7CC1', category: 'Comercio', docs: 'https://apisandbox.facturama.mx/guias/api-web/cfdi/factura',
    description: 'Facturación electrónica CFDI 4.0 para México. La usa el módulo "Facturación CFDI".',
    auth: {
      fields: [field('user', 'Usuario de Facturama'), secret('password', 'Contraseña'), { ...field('sandbox', 'Entorno de pruebas (sí / no)', 'Escribe "no" para facturar de verdad.', 'sí'), optional: true }],
      apply: (h, c) => { h.Authorization = basic(c.user, c.password); },
    },
    actions: [{ key: 'create-cfdi', name: 'Emitir CFDI', method: 'POST',
      url: (_a, c) => `https://${/^no$/i.test(String(c.sandbox ?? '')) ? 'api' : 'apisandbox'}.facturama.mx/3/cfdis`,
      args: [{ key: 'cfdi', label: 'CFDI (JSON según la API de Facturama)', type: 'json', required: true, variables: true }],
      body: (a) => json(a.cfdi), pick: (d) => ({ id: d.Id, folio: d.Folio, serie: d.Serie, total: d.Total, uuid: d.Complement?.TaxStamp?.Uuid }) }],
  },

  // ───────────── Formularios y contenido ─────────────
  {
    key: 'typeform', name: 'Typeform', icon: '📄', color: '#262627', category: 'Formularios', docs: 'https://www.typeform.com/developers/responses/reference/retrieve-responses/',
    description: 'Dispara el flujo con cada respuesta nueva de un formulario.',
    auth: { fields: [secret('token', 'Personal access token')], apply: bearer() },
    triggers: [{ key: 'new-response', name: 'Nueva respuesta', url: (a) => `https://api.typeform.com/forms/${a.formId}/responses?page_size=20`, args: [s('formId', 'ID del formulario', req)],
      items: (d) => (d.items ?? []).map((r: any) => ({ id: r.response_id ?? r.token, submitted: r.submitted_at, answers: Object.fromEntries((r.answers ?? []).map((x: any) => [x.field?.ref ?? x.field?.id, x.text ?? x.email ?? x.number ?? x.choice?.label ?? x.boolean ?? x.date ?? x.url])) })) }],
  },
  {
    key: 'wordpress', name: 'WordPress', icon: '📰', color: '#21759B', category: 'Formularios', docs: 'https://developer.wordpress.org/rest-api/reference/posts/#create-a-post',
    description: 'Publica entradas en tu blog.',
    auth: { fields: [field('siteUrl', 'URL del sitio (https://…)'), field('username', 'Usuario'), secret('appPassword', 'Contraseña de aplicación', 'Usuarios → Perfil → Contraseñas de aplicación.')], apply: (h, c) => { h.Authorization = basic(c.username, c.appPassword); } },
    actions: [{ key: 'post', name: 'Crear entrada', method: 'POST', url: (_a, c) => `${c.siteUrl}/wp-json/wp/v2/posts`,
      args: [s('title', 'Título', req), t('content', 'Contenido (HTML)', req), { key: 'status', label: 'Estado', type: 'dropdown', default: 'draft', options: [{ label: 'Borrador', value: 'draft' }, { label: 'Publicado', value: 'publish' }] }],
      body: (a) => ({ title: a.title, content: a.content, status: a.status || 'draft' }), pick: (d) => ({ id: d.id, url: d.link }) }],
  },

  // ───────────── IA ─────────────
  {
    key: 'claude', name: 'Claude (Anthropic)', icon: '🟠', color: '#D97757', category: 'IA', docs: 'https://platform.claude.com/docs',
    description: 'Genera, resume o analiza texto con Claude.',
    auth: { fields: [secret('apiKey', 'API key de Anthropic (sk-ant-…)')] },
    actions: [{
      key: 'generate', name: 'Generar texto', description: 'Resultado en {{steps.<id>.text}}. Si el modelo rechaza la petición, la API la reintenta con otro modelo automáticamente.',
      args: [t('prompt', 'Instrucción', req), t('system', 'Rol (opcional)'), s('model', 'Modelo', { default: 'claude-opus-5-5' })],
      url: 'https://api.anthropic.com',
      async run(ctx, c) {
        const client = new Anthropic({ apiKey: c.apiKey });
        // fallbacks "default": si hay un rechazo, el servidor reintenta en el modelo adecuado
        const response = await client.beta.messages.create({
          model: String(ctx.args.model || 'claude-opus-5-5'),
          max_tokens: 16000,
          ...(ctx.args.system ? { system: String(ctx.args.system) } : {}),
          messages: [{ role: 'user', content: String(ctx.args.prompt) }],
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        } as Parameters<typeof client.beta.messages.create>[0]) as Anthropic.Beta.BetaMessage;
        if (response.stop_reason === 'refusal') throw new Error('Claude rechazó la petición.');
        const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        return { text, model: response.model, stopReason: response.stop_reason, usage: response.usage };
      },
    }],
  },
  {
    key: 'llm-openai-compatible', name: 'LLM compatible OpenAI', icon: '🧠', color: '#10A37F', category: 'IA', docs: 'https://platform.openai.com/docs/api-reference/chat',
    description: 'Cualquier proveedor con API estilo OpenAI: OpenAI, OpenRouter, Groq, Mistral, Together u Ollama local.',
    auth: { fields: [field('baseUrl', 'URL base', 'p. ej. https://api.openai.com/v1, https://openrouter.ai/api/v1, https://api.groq.com/openai/v1, http://localhost:11434/v1', 'https://api.openai.com/v1'), secret('apiKey', 'API key', undefined)], apply: bearer('apiKey') },
    actions: [{ key: 'chat', name: 'Generar texto', method: 'POST', url: (_a, c) => `${String(c.baseUrl).replace(/\/$/, '')}/chat/completions`,
      args: [s('model', 'Modelo', { required: true, placeholder: 'gpt-4o-mini, llama-3.3-70b-versatile…' }), t('prompt', 'Instrucción', req), t('system', 'Rol (opcional)')],
      body: (a) => ({ model: a.model, messages: [...(a.system ? [{ role: 'system', content: a.system }] : []), { role: 'user', content: a.prompt }] }),
      pick: (d) => ({ text: d.choices?.[0]?.message?.content ?? '', model: d.model, usage: d.usage }) }],
  },
  {
    key: 'gemini', name: 'Google Gemini', icon: '💎', color: '#8E75B2', category: 'IA', docs: 'https://ai.google.dev/api/generate-content',
    description: 'Genera texto con los modelos Gemini.',
    auth: { fields: [secret('apiKey', 'API key de Google AI Studio')], apply: header('x-goog-api-key', 'apiKey') },
    actions: [{ key: 'generate', name: 'Generar texto', method: 'POST', url: (a) => `https://generativelanguage.googleapis.com/v1beta/models/${a.model || 'gemini-2.5-flash'}:generateContent`,
      args: [t('prompt', 'Instrucción', req), s('model', 'Modelo', { default: 'gemini-2.5-flash' })],
      body: (a) => ({ contents: [{ parts: [{ text: a.prompt }] }] }), pick: (d) => ({ text: (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('') }) }],
  },
  {
    key: 'deepl', name: 'DeepL', icon: '🌍', color: '#0F2B46', category: 'IA', docs: 'https://developers.deepl.com/docs/api-reference/translate',
    description: 'Traducción automática de alta calidad.',
    auth: { fields: [secret('authKey', 'Auth key (las gratuitas terminan en :fx)')], apply: header('Authorization', 'authKey', 'DeepL-Auth-Key ') },
    actions: [{ key: 'translate', name: 'Traducir texto', method: 'POST', url: (_a, c) => `https://${String(c.authKey).endsWith(':fx') ? 'api-free' : 'api'}.deepl.com/v2/translate`,
      args: [t('text', 'Texto', req), s('target', 'Idioma destino (EN, ES, FR, DE, PT-BR…)', { required: true, default: 'EN' })],
      body: (a) => ({ text: [a.text], target_lang: String(a.target).toUpperCase() }), pick: (d) => ({ text: d.translations?.[0]?.text, detectado: d.translations?.[0]?.detected_source_language }) }],
  },
];

export default APPS.map(httpApp);
