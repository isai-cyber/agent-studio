// Especificación OpenAPI de la API pública (/v1). Se sirve en /v1/openapi.json.
export function openapi(serverUrl: string): object {
  const json = (schema: object) => ({ 'application/json': { schema } });
  const agent = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string', nullable: true },
      icon: { type: 'string', nullable: true },
      category: { type: 'object' },
      language: { type: 'string' },
      greeting: { type: 'string', nullable: true },
      topics: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, triggers: { type: 'array', items: { type: 'string' } } } } },
    },
  };
  const idParam = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'Agent Studio API',
      version: '0.1.0',
      description: 'Conecta tus agentes con otras apps. Autenticación: `Authorization: Bearer <clave>` o `X-Api-Key`. También hay un servidor MCP en `/mcp` y un endpoint compatible con OpenAI en `/v1/chat/completions`.',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }, { apiKey: [] }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      },
      schemas: { Agent: agent },
    },
    paths: {
      '/v1/agents': {
        get: { summary: 'Listar agentes', responses: { 200: { description: 'OK', content: json({ type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Agent' } } } }) } } },
        post: {
          summary: 'Crear agente',
          requestBody: { required: true, content: json({ type: 'object', required: ['name', 'instructions'], properties: { name: { type: 'string' }, instructions: { type: 'string' }, description: { type: 'string' }, greeting: { type: 'string' } } }) },
          responses: { 201: { description: 'Creado', content: json({ $ref: '#/components/schemas/Agent' }) } },
        },
      },
      '/v1/agents/{id}': {
        get: { summary: 'Ver agente', parameters: [idParam('id')], responses: { 200: { description: 'OK', content: json({ $ref: '#/components/schemas/Agent' }) }, 404: { description: 'No existe' } } },
      },
      '/v1/agents/{id}/chat': {
        post: {
          summary: 'Enviar un mensaje al agente',
          description: 'Para continuar una conversación, envía el `session_id` de la respuesta anterior. Un `message` vacío devuelve el saludo.',
          parameters: [idParam('id')],
          requestBody: { required: true, content: json({ type: 'object', properties: { message: { type: 'string' }, session_id: { type: 'string' } } }) },
          responses: {
            200: {
              description: 'Respuesta del agente',
              content: json({
                type: 'object',
                properties: {
                  session_id: { type: 'string' },
                  reply: { type: 'string' },
                  messages: { type: 'array', items: { type: 'string' } },
                  options: { type: 'array', items: { type: 'string' } },
                  topic: { type: 'string', nullable: true },
                  sources: { type: 'array', items: { type: 'string' } },
                },
              }),
            },
          },
        },
      },
      '/v1/sessions/{id}': { delete: { summary: 'Reiniciar una conversación', parameters: [idParam('id')], responses: { 204: { description: 'Reiniciada' } } } },
      '/v1/templates': { get: { summary: 'Listar plantillas de la biblioteca', responses: { 200: { description: 'OK' } } } },
      '/v1/templates/{id}/use': { post: { summary: 'Crear agente desde plantilla', parameters: [idParam('id')], responses: { 201: { description: 'Creado', content: json({ $ref: '#/components/schemas/Agent' }) } } } },
      '/v1/tts': {
        post: {
          summary: 'Texto a voz (ElevenLabs)',
          requestBody: { required: true, content: json({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, agent_id: { type: 'string' } } }) },
          responses: { 200: { description: 'Audio MP3', content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } } } },
        },
      },
      '/v1/models': { get: { summary: 'Agentes como modelos (compatible con OpenAI)', responses: { 200: { description: 'OK' } } } },
      '/v1/chat/completions': {
        post: {
          summary: 'Chat compatible con OpenAI',
          description: '`model` = id del agente. La conversación se mantiene con la cabecera `X-Session-Id` o el campo `user`. Admite `stream: true`.',
          requestBody: { required: true, content: json({ type: 'object', required: ['model', 'messages'], properties: { model: { type: 'string' }, messages: { type: 'array', items: { type: 'object' } }, stream: { type: 'boolean' }, user: { type: 'string' } } }) },
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  };
}
