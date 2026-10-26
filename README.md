<p align="center"><img src="public/brand-logo.png" alt="Agent Studio" width="140" /></p>

# Agent Studio

Plataforma propia de agentes, alternativa a Copilot Studio: **DeepSeek** como modelo de lenguaje y **ElevenLabs** para la voz. Incluye automatizaciones estilo Zapier con un marketplace de 565 apps (APIs REST y servidores MCP), un asistente que monta flujos hablando, métricas de tokens y coste, API REST y servidor MCP, y usuarios con MariaDB.

## Capturas

| | |
|---|---|
| ![Inicio de sesión](docs/screenshots/01-login.png) **Inicio de sesión** con usuarios en MariaDB | ![Inicio](docs/screenshots/02-inicio.png) **Inicio**: describe lo que quieres automatizar |
| ![Marketplace](docs/screenshots/03-marketplace.png) **Marketplace** de 565 apps con sus logos | ![Servidores MCP](docs/screenshots/04-marketplace-mcp.png) **Servidores MCP** oficiales |
| ![Detalle de una app](docs/screenshots/05-detalle-app.png) **Detalle de una app**: acciones y conexión | ![Editor](docs/screenshots/06-editor-automatizacion.png) **Editor de automatizaciones** paso a paso |
| ![Asistente](docs/screenshots/07-asistente.png) **Asistente** que crea y cambia flujos hablando | ![Métricas](docs/screenshots/08-metricas.png) **Métricas** con el agente en vivo (datos de ejemplo) |
| ![Agentes](docs/screenshots/09-agentes.png) **Agentes** generados desde datasets abiertos | ![Biblioteca](docs/screenshots/10-biblioteca.png) **Biblioteca de escenarios** |
| ![API y MCP](docs/screenshots/11-api-mcp.png) **Conectar** por API REST, OpenAI o MCP | |

## Arranque

```bash
cp .env.example .env   # pon DEEPSEEK_API_KEY, ELEVENLABS_API_KEY y los datos de MariaDB (DB_*)
npm install
npm run build:datasets # opcional: descarga los datasets y regenera el conocimiento de los agentes
npm start              # http://localhost:3000 (la primera cuenta que crees será la de administrador)
```

## Qué incluye

| Copilot Studio | Aquí |
|---|---|
| Modelo GPT | DeepSeek (`DEEPSEEK_BASE_URL` admite Ollama/vLLM para modelos locales) |
| Temas y disparadores | `topics` con pasos: `message`, `question`, `condition`, `set`, `action`, `generate`, `goto`, `end` |
| Conocimiento | `knowledge` (texto, archivos, URLs) con búsqueda BM25 |
| Acciones / Power Automate | `actions`: llamadas HTTP que el LLM usa como herramientas |
| Voz | ElevenLabs TTS + Scribe (voz a texto) |
| Biblioteca de escenarios | `catalog/catalog.yaml`, organizada por función e industria |

## Migrar tus agentes de Copilot Studio

1. En Copilot Studio, añade el agente a una **Solución**.
2. En Power Apps → **Soluciones → Exportar** (no administrada).
3. En la interfaz, ve a **Importar de Copilot Studio** y sube el .zip; o desde la terminal: `npm run import -- Solucion.zip`.

Lo que no se puede traducir automáticamente (flujos de Power Automate, SharePoint, tarjetas adaptativas) sale en el informe como "Revisar" y se marca en el agente con `[IMPORT]`. El YAML original de cada componente se guarda en `agents/<id>/import/`.

## Backend NanoClaw + opencode

Con `AGENT_BACKEND=nanoclaw` en `.env`, cada agente se ejecuta como un agente de **NanoClaw** (en su propio contenedor Docker) con el proveedor **opencode → DeepSeek**. Agent Studio sigue siendo el editor y el chat de pruebas:

- Los **temas guiados** (preguntas, opciones, condiciones) se ejecutan en Agent Studio.
- Las **respuestas libres** las genera el agente en NanoClaw, que guarda su propio historial.
- Al sincronizar, el agente se escribe en `~/nanoclaw/groups/web-<nombre>/CLAUDE.md` (instrucciones, temas, conocimiento y acciones). Ese archivo se regenera: edita el agente aquí, no allí.
- Desde NanoClaw puedes conectar el mismo agente a WhatsApp, Telegram, Slack… (`/add-whatsapp`, `/manage-channels`).

Requisitos: Docker arrancado, NanoClaw con el canal `local-web` y el proveedor opencode instalado (`/add-opencode`), y la clave de DeepSeek registrada en OneCLI:

```bash
onecli secrets create --name "DeepSeek" --type generic --value TU_CLAVE \
  --host-pattern "api.deepseek.com" --header-name "Authorization" --value-format "Bearer {value}"
```

## Conectar con otras apps (API REST y MCP)

La clave de API se genera en `data/api-key` (o define `AGENT_STUDIO_API_KEY`). Envíala como `Authorization: Bearer <clave>` o `X-Api-Key`. En la interfaz, la pantalla **Conectar** tiene la clave y ejemplos listos para copiar.

| Qué | Dónde |
|---|---|
| API REST | `/v1/agents`, `/v1/agents/{id}/chat`, `/v1/templates`, `/v1/tts`… — documentada en `/v1/openapi.json` |
| Compatible con OpenAI | `POST /v1/chat/completions` con `model` = id del agente (la sesión va en `X-Session-Id` o `user`) |
| MCP por HTTP | `POST /mcp` (Streamable HTTP, sin estado) |
| MCP por stdio | `npm run mcp` |

Herramientas MCP: `list_agents`, `get_agent`, `chat_with_agent`, `create_agent`, `list_templates`, `create_agent_from_template`, `reset_conversation`.

La API interna `/api/*` es solo para la interfaz local y no lleva autenticación: si publicas el servidor, expón únicamente `/v1` y `/mcp`.

## Métricas

Cada mensaje se registra en `data/metrics/events.jsonl`: tokens (entrada, caché, salida), coste estimado, latencia de cada paso (clasificar, conocimiento, modelo, acciones, NanoClaw, voz) y ruta (saludo, tema, respuesta libre, NanoClaw), además del canal (interfaz, API, OpenAI, MCP).

La pantalla **Métricas** muestra: tokens en el tiempo por agente, coste acumulado del mes frente al presupuesto, coste por agente, latencia por paso y coste por resultado de cada conversación. Cada gráfica tiene vista de tabla. Los mismos datos están en `GET /v1/metrics?range=24h|7d|30d`.

Los precios y el presupuesto se configuran en `.env` (`PRICE_INPUT_PER_M`, `PRICE_OUTPUT_PER_M`, `MONTHLY_BUDGET_USD`…). Por NanoClaw no llegan cifras de tokens: esos mensajes cuentan latencia y ruta, y se indican aparte.

## Agente en vivo (visualización)

El flujo de NanoClaw (canal → router → inbound.db → contenedor → memoria → skills/MCP → outbound.db → entrega) se dibuja en 3D en `public/nanoclaw-flow.html` (canvas 2D con proyección en perspectiva propia, sin librerías): suelo holográfico, nubes como volúmenes flotantes, la caja del contenedor en alambre y una araña cuyas patas se resuelven con FABRIK en 3D. Arrastra para girar la cámara; haz clic en el suelo para mover a la araña.

En **Métricas** está la tarjeta **Agente en vivo**: la misma araña, pero guiada por las métricas del periodo elegido. El tiempo que pasa en cada nube es proporcional a la latencia de esa fase; su velocidad, a la latencia p50; sus patas, a los agentes activos y las conversaciones; su latido, a los mensajes por hora; y el núcleo se pone rojo si se rompe el SLA (proyección por encima del presupuesto, p95 > 8 s o errores). Cada nube muestra su métrica (conversaciones, % resuelto por temas, tokens, coste…).

## Automatizaciones y módulos

**Automatizaciones** es un editor de flujos de arrastrar y soltar: un disparador (manual, webhook, programado, "un agente responde" o sondeo) y una serie de acciones. Las salidas de cada paso se usan en los siguientes con `{{trigger.…}}` y `{{steps.<id>.…}}`; el botón **Probar** muestra el resultado de cada paso y las variables disponibles.

- Webhooks públicos: `POST /hooks/<id-del-flujo>` (con `?token=` si el disparador tiene secreto).
- Ejecutar por API: `POST /v1/flows/<id>/run` con la clave de API.
- Historial: `data/flows/runs/<id>.jsonl`.

**Módulos** integrados en `modules/`: básicos (filtro, espera, variables), HTTP, agentes, IA (DeepSeek y ElevenLabs), formato, mensajería (Telegram, Discord, Slack) y APIs públicas (clima, divisas, festivos). Los de la comunidad van en `modules-community/` y se instalan desde la pantalla Módulos pegando la URL de un archivo. Cómo crear uno: [MODULES.md](MODULES.md).

La forma de los módulos se inspira en las apps de [Automatisch](https://github.com/automatisch/automatisch), pero no incluye su código (AGPL-3.0): es una implementación propia.

## Agentes generados desde datasets

`npm run build:datasets` crea 10 agentes a partir de Schema-Guided Dialogue, MultiWOZ 2.2, Taskmaster-2, τ²-bench, Bitext y public-apis (temas guiados, frases reales, conversaciones de ejemplo, políticas y acciones con APIs sin clave). Fuentes y licencias en `agents/<id>/knowledge/fuentes.md`.

## Usuarios e inicio de sesión (MariaDB)

- Se activa al definir `DB_HOST` en `.env` (ver `.env.example`). Al arrancar crea las tablas `users` y `sessions` en la base `agent_studio`.
- **La primera cuenta que se registra es la de administrador.** Con `AUTH_ALLOW_SIGNUP=false` solo se puede crear esa primera cuenta.
- Contraseñas con scrypt y sal por usuario. La sesión es una cookie `HttpOnly; SameSite=Lax` de 30 días, y en la base solo se guarda el SHA-256 del token. Hay bloqueo de 15 min tras 8 intentos fallidos por email e IP, y se rechazan las peticiones que cambian datos desde otro origen. Si sirves la app por HTTPS, pon `COOKIE_SECURE=true`.
- Toda la API de la interfaz (`/api/*`) pide sesión. La API pública `/v1` y `/mcp` siguen usando la clave de `data/api-key`, y los webhooks `/hooks/*` su token opcional.
- Todavía no hay recuperación de contraseña por email ni gestión de usuarios desde la interfaz.

## Conectar con más apps

- **50 conectores nativos** (`modules/apps/index.ts`): Slack, Discord, Telegram, WhatsApp Business, Twilio, Teams, Google Chat, Mattermost, ntfy, Pushover, Gmail, Resend, SendGrid, Mailgun, Postmark, Brevo, Mailchimp, Notion, Airtable, Google Sheets, Google Calendar, Todoist, Trello, Asana, ClickUp, monday.com, Jira, Linear, GitHub, GitLab, Supabase, RSS, HubSpot, Pipedrive, Salesforce, Zendesk, Freshdesk, Intercom, Stripe, Shopify, WooCommerce, Mercado Pago, Typeform, WordPress, Claude, cualquier LLM compatible con OpenAI, Gemini y DeepL. Cada uno es una definición declarativa (`src/modules/http-app.ts`): añadir una app son unas líneas.
- **Conexiones**: cada flujo tiene el paso «Elegir conexión»; las credenciales se guardan una vez en `data/connections.json` (permisos 0600, sin cifrar) o en el `.env` como `FLOW_<APP>_<CAMPO>`, y nunca se devuelven completas a la interfaz.
- **MCP**: el módulo «MCP (cualquier servidor)» lista y llama herramientas de cualquier servidor MCP (HTTP, SSE o stdio). Los agentes también pueden usarlos: añade `mcpServers: [{ name, url, headers }]` a su YAML y sus herramientas estarán disponibles en las respuestas del modelo.
- **OpenAPI**: el módulo «Cualquier API (OpenAPI)» llama a cualquier operación de una especificación OpenAPI/Swagger.
- **Marketplace de 565 apps** (vista «Apps», inspirada en el marketplace de Dify; diseño propio, sin código de Dify): pestañas por tipo, categorías con contadores, búsqueda, tarjetas con el logo real de cada app y un panel con sus acciones, la conexión y «Usar en una automatización».
  - **469 APIs REST** generadas desde [APIs.guru](https://apis.guru) (CC0): hasta 15 operaciones por API con sus parámetros, la autenticación que declara la especificación y la acción «Llamar a cualquier endpoint». Solo se incluyen APIs cuyo servidor respondía al generar el catálogo. Ojo: muchas especificaciones son antiguas, así que algunas rutas pueden haber cambiado, y algunas APIs piden una clave que no declaran (para eso están los campos «Cabeceras extra» y «Parámetros extra» de la conexión). Los nombres de acciones y descripciones vienen en inglés, como en la especificación.
  - **39 servidores MCP oficiales** (Notion, Linear, Atlassian, Asana, Stripe, PayPal, GitHub, Figma, Canva, Vercel, Supabase, HubSpot, Zapier…), con «Ver herramientas» y «Usar una herramienta». Solo se incluyen los que respondían al generar. Muchos usan OAuth en el navegador, que Agent Studio todavía no gestiona: si el servidor da un token personal, se pega en la conexión.
  - **Logos**: [Simple Icons](https://simpleicons.org) (CC0) en el color de la marca; si la marca no está, el logo de la especificación o el favicon de su dominio, guardados en `public/logos/`. Las marcas pertenecen a sus dueños y solo identifican la app.
  - Se regenera con `npm run build:catalog` (descarga ~670 especificaciones; usa Simple Icons descomprimido en `/tmp/si/package` o en `SI_DIR`). Las apps hechas a mano en `modules/apps` tienen prioridad sobre las generadas.

## Asistente de automatización y onboarding

En **Inicio**, escribe lo que quieres («Cuando llegue un pedido de Shopify avisa en Slack») y Agent Studio crea el flujo —y un agente si la petición lo describe— y te lleva al editor. El botón **✨ Asistente** abre un chat en cualquier pantalla para seguir ajustando hablando: «añade un correo», «quita el paso 3», «cámbialo a cada hora», «conecta https://…/mcp», «publícalo». Con `DEEPSEEK_API_KEY` el plan lo hace el modelo con el catálogo de módulos; sin ella se usan reglas propias. Rutas: `POST /api/assistant/plan` y `POST /api/assistant/chat`.

## Créditos de datos

- Conocimiento de los agentes generado a partir de Taskmaster-2 (CC BY 4.0), Schema-Guided Dialogue / DSTC8 (CC BY-SA 4.0), MultiWOZ 2.2, τ²-bench, el dataset de soporte de Bitext en Hugging Face y public-apis. Revisa la licencia de cada uno antes de usarlo comercialmente.
- Catálogo de APIs: [APIs.guru](https://apis.guru) (CC0). Servidores MCP: [registro oficial de MCP](https://registry.modelcontextprotocol.io). Logos: [Simple Icons](https://simpleicons.org) (CC0); las marcas pertenecen a sus dueños.
- El diseño de automatizaciones se inspira en Zapier y Automatisch, y el del marketplace en Dify. No contiene código de ninguno de ellos.
