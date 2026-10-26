# Crear módulos para Agent Studio

Un **módulo** añade disparadores y acciones a las **Automatizaciones** (el editor de flujos de arrastrar y soltar). La forma de definirlos se inspira en las *apps* de [Automatisch](https://github.com/automatisch/automatisch) (`name`, `key`, `arguments`…), pero Agent Studio no incluye código de Automatisch: es una implementación propia, así que tu módulo no queda sujeto a la AGPL.

## En 3 pasos

1. Copia `modules/_plantilla/` a `modules-community/<tu-clave>/`.
2. Edita `index.js` (o `index.ts`): cambia `key`, `name` y escribe tus acciones.
3. En la app, ve a **Módulos → Recargar**. Tu módulo aparece en la paleta del editor de flujos.

Para compartirlo, publica el archivo (por ejemplo en GitHub) y cualquiera podrá instalarlo pegando su URL "raw" en **Módulos → Añadir un módulo de la comunidad**.

## Estructura

```js
export default {
  key: 'mi-modulo',        // único: minúsculas, números y guiones
  name: 'Mi módulo',
  description: 'Qué hace',
  icon: '🧩', color: '#8b5cf6', category: 'Comunidad',
  author: 'Tu nombre', version: '1.0.0', homepage: 'https://…',
  triggers: [ /* qué inicia un flujo */ ],
  actions:  [ /* pasos del flujo */ ],
};
```

### Acciones

```js
{
  key: 'enviar',
  name: 'Enviar algo',
  description: 'Se muestra en la paleta y el inspector',
  arguments: [
    { key: 'texto', label: 'Texto', type: 'text', required: true, variables: true },
  ],
  async run(ctx) {
    // Lo que devuelvas queda disponible como {{steps.<id-del-paso>.campo}}
    return { ok: true };
  },
}
```

Tipos de `arguments`: `string`, `text`, `number`, `boolean`, `dropdown` (con `options: [{label, value}]`), `json` y `agent` (selector de agentes). `variables: true` indica que el campo admite `{{variables}}`; `default` rellena el valor inicial.

### Disparadores

| `type` | Cuándo se ejecuta | Datos en `{{trigger}}` |
|---|---|---|
| `manual` | Botón **Probar** o `POST /v1/flows/<id>/run` | El JSON de prueba |
| `webhook` | `POST /hooks/<id-del-flujo>` | `method`, `body`, `query`, `headers` |
| `schedule` | Cada `everyMinutes` minutos | `programado` (fecha) |
| `event` | Evento interno; hoy: `agent.turn` | `agentId`, `message`, `reply`, `topic`, `sessionId` |
| `poll` | Cada `everyMinutes`, llamando a tu `run()` | Cada elemento nuevo (por `id`) |

Un disparador `poll` devuelve una lista de objetos con `id`. La primera vez solo se memorizan; después, cada `id` nuevo ejecuta el flujo.

## El contexto `ctx`

| Campo | Para qué |
|---|---|
| `ctx.args` | Argumentos del paso, ya con las `{{variables}}` sustituidas |
| `ctx.trigger`, `ctx.steps` | Datos del disparador y salidas de los pasos anteriores |
| `ctx.env` | Solo variables del `.env` que empiezan por `FLOW_` |
| `ctx.fetchJson(url, init)` | `fetch` con tiempo límite que devuelve JSON (o texto) |
| `ctx.agentStudio.chat(agentId, mensaje, sesión?)` | Habla con un agente |
| `ctx.agentStudio.llm(prompt, sistema?, temperatura?)` | Texto con DeepSeek |
| `ctx.agentStudio.tts(texto, voiceId?)` | MP3 con ElevenLabs (`{ url, bytes }`) |
| `ctx.log(texto)` | Añade una línea al historial de la ejecución |
| `return ctx.stop(motivo)` | Detiene el flujo (como un filtro) |

## Secretos

No escribas claves en el módulo. Pídelas como argumento con un valor por defecto `{{env.FLOW_MI_SERVICIO_TOKEN}}` y explica en la descripción que se definen en el `.env`. Los flujos y los módulos **no** ven el resto de variables del servidor (como `DEEPSEEK_API_KEY`).

## Seguridad

Un módulo es código que se ejecuta en el servidor con los mismos permisos que Agent Studio. Instala solo módulos de fuentes en las que confíes y revisa el código antes.
