// Idioma de la interfaz: español (original) o inglés, según el idioma que el
// superadmin eligió para la empresa (tenants.language).
//
// En vez de reescribir cada pantalla, se traduce lo que se pinta: un observador
// recorre los textos y atributos visibles (placeholder, title, aria-label) y los
// cambia por su versión en inglés con este diccionario; también los avisos de
// alert(), confirm() y prompt(). No se traduce lo que escriben los usuarios ni las
// conversaciones con los agentes (.msg, textarea, code, pre, [data-no-i18n]).
//
// Para completar el diccionario: en inglés, window.__untranslated lista los
// textos en español que no encontró.

const EXACT = {
  // ---------- menú, cabecera y comunes ----------
  'Inicio': 'Home', 'Mis agentes': 'My agents', 'Biblioteca de escenarios': 'Scenario library', 'Importar de Copilot Studio': 'Import from Copilot Studio',
  'Automatizaciones': 'Automations', 'Apps': 'Apps', 'Métricas': 'Metrics', 'Conectar (API y MCP)': 'Connect (API and MCP)', 'Configuración': 'Settings',
  'Superadmin: empresas y planes': 'Superadmin: companies and plans', 'Empresas y planes': 'Companies and plans', 'Estado de los servicios': 'Service status',
  'Empresa activa': 'Active company', 'Cerrar sesión': 'Log out', 'Salir del modo soporte': 'Exit support mode', '(queda en su auditoría)': '(recorded in their audit log)',
  'Cargando…': 'Loading…', 'Guardar': 'Save', 'Guardar cambios': 'Save changes', 'Cancelar': 'Cancel', 'Cerrar': 'Close', 'Eliminar': 'Delete', 'Editar': 'Edit', 'Ver': 'View',
  'Copiar': 'Copy', '✔ Copiado': '✔ Copied', '✔ Guardado': '✔ Saved', '✓ Guardado': '✓ Saved', 'Guardando…': 'Saving…', 'Sin cambios': 'No changes', 'Probar': 'Test', 'Probando…': 'Testing…',
  'Crear': 'Create', 'Creando…': 'Creating…', 'Enviar': 'Send', '← Volver': '← Back', 'Volver': 'Back', 'Activar': 'Enable', 'Desactivar': 'Disable', 'Quitar': 'Remove', 'Anular': 'Cancel',
  'Activo': 'Active', 'Inactivo': 'Inactive', 'Activa': 'Active', 'Desactivado': 'Disabled', 'Todas': 'All', 'Todos': 'All', 'Otros': 'Others', 'Total': 'Total', 'Día': 'Day',
  'Nombre': 'Name', 'Email': 'Email', 'Rol': 'Role', 'Estado': 'Status', 'Fecha': 'Date', 'Acción': 'Action', 'Objetivo': 'Target', 'Antes': 'Before', 'Después': 'After', 'Clave': 'Key',
  'Permisos': 'Permissions', 'Creada': 'Created', 'Último uso': 'Last used', 'Último acceso': 'Last login', 'Caduca': 'Expires', 'Concepto': 'Description', 'Importe': 'Amount', 'Forma': 'Method',
  'tú': 'you', 'Sistema': 'System', 'Usuario': 'User', 'Superadmin': 'Superadmin', 'Clave de API': 'API key', 'Empresa': 'Company', 'Plan': 'Plan', 'Agentes': 'Agents', 'Usuarios': 'Users',
  'Español': 'Spanish', 'Inglés': 'English', 'Idioma': 'Language', 'Cobro': 'Billing', 'Forma de cobro': 'Billing method', 'Sin cobro': 'No billing',

  // ---------- inicio ----------
  'construir?': 'build?', 'Describe lo que quieres y te dejo la automatización lista': "Describe what you want and I'll set up the automation for you",
  '+560 apps · webhooks · APIs · MCP': '+560 apps · webhooks · APIs · MCP',
  'Describe qué quieres automatizar… ej. «Cuando llegue un pedido de Shopify avisa en Slack»': 'Describe what you want to automate… e.g. "When a Shopify order arrives, notify Slack"',
  'Agente': 'Agent', 'desde cero': 'from scratch', 'Escribe qué quieres que haga y empieza a probarlo al instante.': 'Write what you want it to do and start testing it right away.',
  'Desde plantilla': 'From a template', '19 escenarios': '19 scenarios', 'Elige por función o industria: ventas, soporte, RR. HH., salud…': 'Choose by role or industry: sales, support, HR, health…',
  'Importar': 'Import', 'Copilot Studio': 'Copilot Studio', 'Sube la solución exportada y conserva temas e instrucciones.': 'Upload the exported solution and keep topics and instructions.',
  'Otras formas de crear': 'Other ways to create', 'Agente en blanco editando el YAML: temas, conocimiento, acciones y voz.': 'Blank agent editing the YAML: topics, knowledge, actions and voice.',
  'Agentes recientes': 'Recent agents', 'Todavía no hay agentes: crea el primero arriba.': 'No agents yet: create the first one above.', 'Crear agente': 'Create agent',
  'Cuando llegue un pedido de Shopify avisa en Slack': 'When a Shopify order arrives, notify Slack', 'Atiende a clientes por Telegram con un agente': 'Serve customers on Telegram with an agent',
  'Cada mañana envíame el clima por Telegram': 'Send me the weather on Telegram every morning', 'Cuando alguien responda mi Typeform, crea un contacto en HubSpot': 'When someone answers my Typeform, create a HubSpot contact',
  'Creando tu automatización': 'Creating your automation', 'Entendiendo lo que quieres': 'Understanding what you want', 'Eligiendo apps, webhooks y conexiones': 'Choosing apps, webhooks and connections',
  'Creando tu agente y tu automatización': 'Creating your agent and your automation', 'Abriendo el editor': 'Opening the editor',

  // ---------- agentes ----------
  '+ Nuevo agente': '+ New agent', 'Aún no tienes agentes. Crea uno, usa una plantilla de la biblioteca o importa desde Copilot Studio.': "You don't have agents yet. Create one, use a library template or import from Copilot Studio.",
  'Importado': 'Imported', 'Nombre del agente': 'Agent name', 'Escribe un mensaje…': 'Type a message…', 'Hablar': 'Speak', 'Responder con voz (ElevenLabs)': 'Reply with voice (ElevenLabs)',
  'Reiniciar conversación': 'Restart conversation', 'Ver voces de ElevenLabs': 'See ElevenLabs voices', 'Regenerar CLAUDE.md (Claude Code)': 'Regenerate CLAUDE.md (Claude Code)',
  'Regenerando CLAUDE.md…': 'Regenerating CLAUDE.md…', 'Ya estaba al día': 'Already up to date', 'Agente en blanco': 'Blank agent', 'Eres un asistente útil.': 'You are a helpful assistant.',
  'Usar plantilla': 'Use template', 'Funciones': 'Functions', 'Industrias': 'Industries', 'Encuentra tu función o industria y crea un agente a partir de una plantilla.': 'Find your role or industry and create an agent from a template.',
  'No hay plantillas para este filtro todavía.': 'No templates for this filter yet.',
  '1. Solución completa (.zip)': '1. Full solution (.zip)', '2. Tema suelto (YAML)': '2. Single topic (YAML)', 'Importar solución': 'Import solution', 'Importar tema': 'Import topic',
  'Nombre del agente (nuevo)': 'Agent name (new)', 'Importando…': 'Importing…', 'Selecciona el .zip de la solución': 'Select the solution .zip', '¡Hola! ¿En qué te puedo ayudar hoy?': 'Hi! How can I help you today?',

  // ---------- automatizaciones ----------
  '+ Nuevo flujo': '+ New flow', 'Conecta tus agentes con otras apps: elige qué inicia la automatización y qué debe pasar después.': 'Connect your agents with other apps: choose what starts the automation and what should happen next.',
  'Empieza con una plantilla': 'Start with a template', 'Tus automatizaciones': 'Your automations', 'Aún no tienes automatizaciones. Empieza con una plantilla o crea una desde cero.': "You don't have automations yet. Start with a template or create one from scratch.",
  'Publicado': 'Published', '● Publicado': '● Published', 'Borrador': 'Draft', '⏸ En pausa': '⏸ Paused', 'PUBLICAR': 'PUBLISH', 'PAUSAR': 'PAUSE', 'Sin ejecuciones todavía': 'No runs yet',
  'Nombre de la automatización': 'Automation name', 'Nueva automatización': 'New automation', 'Flujo sin nombre': 'Untitled flow', 'Disparador': 'Trigger', 'Paso': 'Step',
  'Elegir app y evento': 'Choose app and event', 'Elegir conexión': 'Choose connection', 'Configurar disparador': 'Set up trigger', 'Configurar acción': 'Set up action',
  'Probar disparador': 'Test trigger', 'Probar acción': 'Test action', '1. Disparador': '1. Trigger', '1. Elige qué inicia el flujo': '1. Choose what starts the flow', 'Elige una acción': 'Choose an action',
  'Evento que inicia el flujo': 'Event that starts the flow', 'Qué debe hacer': 'What it should do', 'Elige una app para ver sus opciones.': 'Choose an app to see its options.',
  'Este paso no necesita configuración.': 'This step needs no setup.', 'Primero elige el disparador.': 'Choose the trigger first.', 'Añade al menos una acción.': 'Add at least one action.',
  'Añadir un paso': 'Add a step', 'Añadir un paso aquí': 'Add a step here', 'Eliminar paso': 'Delete step', '¿Eliminar este paso?': 'Delete this step?', 'Arrastra para reordenar': 'Drag to reorder',
  'Nombre del paso': 'Step name', 'Insertar un dato de un paso anterior': 'Insert data from a previous step', 'URL para recibir datos': 'URL to receive data',
  'Envía aquí un POST con JSON. Funciona cuando el flujo está publicado.': 'Send a JSON POST here. It works when the flow is published.',
  'Datos de ejemplo para probar': 'Sample data for testing', 'Simulan lo que llegará de verdad. Se usan al pulsar "Probar".': 'They simulate what will really arrive. Used when you press "Test".',
  '▶ Probar ahora': '▶ Test now', 'Abrir en el editor': 'Open in the editor', 'Cualquier agente': 'Any agent', 'Elige un agente…': 'Choose an agent…', 'sin elegir': 'not chosen',
  'Se ejecuta el flujo completo con los datos de prueba y verás el resultado de este paso.': "The whole flow runs with the test data and you'll see this step's result.",
  'Se ejecuta el flujo con los datos de prueba para ver qué datos produce el disparador.': 'The flow runs with the test data to see what data the trigger produces.',
  'Todavía no hay datos. Prueba el disparador (o los pasos anteriores) para poder usarlos aquí.': 'No data yet. Test the trigger (or previous steps) to use it here.',
  'Se guardan cifradas (AES-256-GCM) con la clave de tu empresa y nunca se muestran completas.': "They are stored encrypted (AES-256-GCM) with your company's key and never shown in full.",
  'Se reanudará solo al reactivar el módulo.': 'It will resume when the module is turned back on.', 'Conexión': 'Connection', 'Conectar': 'Connect', 'Documentación ↗': 'Docs ↗', '¿Dónde consigo estos datos? ↗': 'Where do I get this? ↗',
  '(déjalo vacío para no cambiarlo)': '(leave empty to keep it)', '(vacío = sin cambios)': '(empty = no change)', 'Desconectar': 'Disconnect',
  'Avisar en Slack cuando un agente escala a una persona': 'Notify Slack when an agent escalates to a person', 'Recibir un webhook y responder con un agente': 'Receive a webhook and reply with an agent',
  'Enviar el clima cada mañana por Telegram': 'Send the weather on Telegram every morning', 'Escalados → Slack': 'Escalations → Slack', 'Webhook → agente': 'Webhook → agent', 'Clima diario → Telegram': 'Daily weather → Telegram',
  'Avisar al equipo': 'Notify the team', 'Preguntar al agente': 'Ask the agent', 'Consultar el clima': 'Check the weather', 'Enviar por Telegram': 'Send via Telegram',

  // ---------- marketplace ----------
  'Marketplace de apps': 'App marketplace', 'Buscar apps, acciones o categorías…': 'Search apps, actions or categories…', 'Buscar apps': 'Search apps', 'Ordenar': 'Sort',
  'Destacadas': 'Featured', 'A–Z': 'A–Z', 'Más acciones': 'Most actions', 'Categorías': 'Categories', 'App nativa': 'Native app', 'Apps nativas': 'Native apps', 'Herramienta': 'Tool',
  'Herramientas': 'Tools', 'Comunidad': 'Community', 'Usar en una automatización': 'Use in an automation', 'Crear una automatización con esta acción': 'Create an automation with this action',
  'Disparadores': 'Triggers', 'Acciones': 'Actions', 'Sin descripción.': 'No description.', 'Conectado': 'Connected', 'Añadir un módulo de la comunidad': 'Add a community module',
  'Instalar': 'Install', 'Recargar módulos': 'Reload modules', 'Instalando…': 'Installing…', 'Desinstalar': 'Uninstall',
  'Un módulo ejecuta código en tu servidor. Instala solo módulos de fuentes de confianza. ¿Continuar?': 'A module runs code on your server. Only install modules from trusted sources. Continue?',

  // ---------- métricas ----------
  '24 h': '24 h', '7 días': '7 days', '30 días': '30 days', 'Agente en vivo': 'Live agent', 'Tokens en el tiempo': 'Tokens over time', 'Entrada + salida por agente': 'Input + output per agent',
  'Coste acumulado del mes': 'Cost so far this month', 'Frente al presupuesto mensual': 'Against the monthly budget', 'Coste por agente': 'Cost per agent', 'Ordenado de mayor a menor': 'Highest first',
  'Latencia por paso': 'Latency per step', 'Tiempo medio de cada fase de una respuesta': 'Average time of each phase of a reply', 'Coste por resultado': 'Cost per outcome',
  'Cada punto es una conversación': 'Each dot is a conversation', 'Coste por modelo': 'Cost per model', 'Ver tabla': 'View table', 'Ver gráfica': 'View chart',
  'Cada proveedor y modelo usado (DeepSeek, Qwen…): conversaciones, flujos y asistente': 'Each provider and model used (DeepSeek, Qwen…): conversations, flows and assistant',
  'Modelo': 'Model', 'Llamadas': 'Calls', 'Tokens de entrada': 'Input tokens', 'De caché': 'From cache', 'Tokens de salida': 'Output tokens', 'Coste': 'Cost', 'Coste por llamada': 'Cost per call',
  'Todavía no hay llamadas a modelos en este periodo.': 'No model calls in this period yet.', 'Sin datos en este periodo': 'No data in this period', 'Aún no hay gasto este mes': 'No spend yet this month',
  'Generar datos de ejemplo': 'Generate sample data', 'Quitar datos de ejemplo': 'Remove sample data', 'Tokens': 'Tokens', 'Conversaciones': 'Conversations', 'Mensajes': 'Messages',
  'Latencia': 'Latency', 'Coste medio': 'Average cost', 'Tokens medios': 'Average tokens', 'Gasto del día': 'Daily spend', 'Acumulado': 'Cumulative', 'Presupuesto': 'Budget', 'Periodo': 'Period',
  'Resultado': 'Outcome', 'Media': 'Average', 'Muestras': 'Samples', 'Coste / conversación': 'Cost / conversation', 'Coste por conversación según su resultado': 'Cost per conversation by outcome',
  'Coste acumulado del mes frente al presupuesto': 'Cost this month against the budget', 'Latencia media por paso': 'Average latency per step', 'Tokens en el tiempo por agente': 'Tokens over time per agent',
  'Flujo guiado': 'Guided flow', 'Respuesta libre': 'Free answer', 'Escalado': 'Escalated', 'Abandonada': 'Abandoned', 'Clasificar tema': 'Classify topic', 'Buscar conocimiento': 'Search knowledge',
  'Modelo de lenguaje': 'Language model', 'Acciones / herramientas': 'Actions / tools', 'Servidores MCP': 'MCP servers', 'Módulos de negocio': 'Business modules', 'Motor y red': 'Engine and network',
  'Voz (ElevenLabs)': 'Voice (ElevenLabs)', 'datos de ejemplo': 'sample data', 'mezclados con los reales.': 'mixed with the real ones.',
  'Todavía no hay mensajes registrados. Habla con un agente o genera datos de ejemplo para ver el panel.': 'No messages recorded yet. Talk to an agent or generate sample data to see the dashboard.',

  // ---------- conectar ----------
  'Conectar con otras apps': 'Connect with other apps', 'Claves de API': 'API keys', 'Gestionar claves de API': 'Manage API keys', 'API REST': 'REST API', 'Compatible con OpenAI': 'OpenAI-compatible',
  'MCP por HTTP': 'MCP over HTTP', 'MCP por stdio': 'MCP over stdio', 'Para clientes que admiten servidores MCP remotos.': 'For clients that support remote MCP servers.',
  'Claude Desktop, Cursor u opencode lanzan el proceso ellos mismos.': 'Claude Desktop, Cursor or opencode launch the process themselves.',
  'Usa tus agentes desde cualquier app con la API REST, el endpoint compatible con OpenAI o MCP (Claude Desktop, Cursor, opencode, n8n…).': 'Use your agents from any app with the REST API, the OpenAI-compatible endpoint or MCP (Claude Desktop, Cursor, opencode, n8n…).',
  'Documentación:': 'Docs:', 'Webhooks de tu empresa:': "Your company's webhooks:",

  // ---------- configuración ----------
  'Módulos': 'Modules', 'Roles': 'Roles', 'Auditoría': 'Audit log', 'Facturación': 'Billing',
  'Activa las funciones de negocio que use tu empresa. Desactivar un módulo no borra sus datos: al reactivarlo todo vuelve como estaba.': 'Turn on the business features your company uses. Turning a module off does not delete its data: when you turn it back on, everything is as it was.',
  'E-commerce y WhatsApp': 'E-commerce and WhatsApp', 'Reservas y voz': 'Bookings and voice', 'Monetización': 'Monetization',
  'Requiere configuración': 'Needs setup', 'No incluido en tu plan': 'Not included in your plan', 'No disponible': 'Not available', 'Siempre activo': 'Always on',
  'Base de seguridad: siempre activo': 'Security baseline: always on', 'Depende de:': 'Depends on:', 'Falta conectar:': 'Missing connection:', 'Necesita:': 'Needs:', 'Mejorar plan': 'Upgrade plan',
  'Guardar configuración': 'Save settings', 'Uno por línea': 'One per line',
  'Este módulo no está incluido en tu plan. Pide al administrador de la plataforma que mejore el plan de tu empresa.': "This module isn't included in your plan. Ask the platform administrator to upgrade your company's plan.",
  'Sin MariaDB los módulos se muestran en solo lectura. Define DB_HOST en .env para gestionarlos por empresa.': 'Without MariaDB, modules are read-only. Set DB_HOST in .env to manage them per company.',
  'Invitar a una persona': 'Invite someone', 'Invitar': 'Invite', 'email@empresa.com': 'email@company.com', 'Invitaciones pendientes': 'Pending invitations',
  'Le enviaremos un correo con el enlace de invitación.': "We'll email them the invitation link.", 'No hay correo configurado: al invitar verás un enlace para compartirlo tú.': "No email is set up: when you invite, you'll see a link to share yourself.",
  '¿Quitar a esta persona de la empresa? Podrás invitarla de nuevo.': 'Remove this person from the company? You can invite them again.',
  'Los roles del sistema son plantillas de solo lectura. Clónalos para crear roles propios. Solo puedes dar permisos que tú tengas.': "System roles are read-only templates. Clone them to create your own roles. You can only grant permissions you have.",
  'Clonar': 'Clone', '+ Nuevo rol': '+ New role', 'Nuevo rol': 'New role', 'Nombre del rol': 'Role name', 'Descripción (opcional)': 'Description (optional)', 'Guardar rol': 'Save role', '¿Eliminar este rol?': 'Delete this role?',
  'Propietario': 'Owner', 'Admin': 'Admin', 'Operador': 'Operator', 'Solo lectura': 'Read only', 'Soporte (superadmin)': 'Support (superadmin)',
  'Todos los permisos, incluida la facturación y eliminar la empresa.': 'All permissions, including billing and deleting the company.',
  'Todos los permisos salvo facturación y eliminar la empresa.': 'All permissions except billing and deleting the company.',
  'Usa los módulos activos (bandeja, contactos, pedidos, citas). No cambia configuración, módulos ni usuarios.': "Uses the active modules (inbox, contacts, orders, appointments). Doesn't change settings, modules or users.",
  'Únicamente los permisos de lectura (*.read).': 'Read permissions only (*.read).',
  'Ver agentes y chatear con ellos': 'View agents and chat with them', 'Crear, editar, importar y eliminar agentes': 'Create, edit, import and delete agents', 'Ver automatizaciones y sus ejecuciones': 'View automations and their runs',
  'Crear, editar, ejecutar y eliminar automatizaciones': 'Create, edit, run and delete automations', 'Ver métricas': 'View metrics', 'Ver el registro de auditoría': 'View the audit log',
  'Invitar, cambiar el rol y quitar usuarios': 'Invite, change role and remove users', 'Crear y editar roles': 'Create and edit roles', 'Activar, desactivar y configurar módulos': 'Enable, disable and configure modules',
  'Conectar apps y gestionar credenciales': 'Connect apps and manage credentials', 'Crear y revocar claves de API': 'Create and revoke API keys', 'Facturación y plan': 'Billing and plan', 'Eliminar la empresa': 'Delete the company',
  'Nueva clave de API': 'New API key', 'Nombre (p. ej. «n8n producción»)': 'Name (e.g. "n8n production")', 'Permisos (scopes)': 'Permissions (scopes)',
  'Chatear con agentes': 'Chat with agents', 'Todos mis permisos': 'All my permissions', 'Crear clave': 'Create key', 'Aún no hay claves.': 'No keys yet.', 'Revocar': 'Revoke',
  'Copia la clave ahora: no se volverá a mostrar.': "Copy the key now: it won't be shown again.", '¿Revocar la clave? Las apps que la usen dejarán de funcionar al momento.': 'Revoke the key? Apps using it will stop working immediately.',
  'Registro de solo lectura de todos los cambios de módulos, roles, usuarios, conexiones y claves de API, y de cada inicio de sesión. Nadie puede editarlo ni borrarlo.': 'Read-only record of every change to modules, roles, users, connections and API keys, and of every login. Nobody can edit or delete it.',
  'Actor (email o: user, api_key, system, superadmin)': 'Actor (email or: user, api_key, system, superadmin)', 'Acción (p. ej. feature, member, auth.login)': 'Action (e.g. feature, member, auth.login)',
  'Desde': 'From', 'Hasta': 'To', 'Filtrar': 'Filter', 'Exportar CSV': 'Export CSV', 'Cargar más': 'Load more', 'Actor': 'Actor', 'IP': 'IP',
  'Pendiente de pago': 'Payment pending', 'Pagado': 'Paid', 'Anulado': 'Cancelled', 'Pendiente': 'Pending', 'Pagar ↗': 'Pay ↗', 'Cobros': 'Charges', 'No tienes cobros pendientes.': 'You have no pending charges.',
  'Conversaciones este mes': 'Conversations this month', 'Sin límite': 'No limit', 'permitidos': 'allowed',
  'Aún no perteneces a ninguna empresa': "You don't belong to any company yet",
  'Pide a quien administra tu empresa en Agent Studio que te invite. Si ya tienes un enlace de invitación, ábrelo para unirte.': 'Ask whoever manages your company in Agent Studio to invite you. If you already have an invitation link, open it to join.',

  // ---------- módulos de negocio (registro) ----------
  'Mini CRM': 'Mini CRM', 'Bandeja compartida': 'Shared inbox', 'Inventario ligero': 'Light inventory', 'Pedidos y pagos': 'Orders and payments', 'Carritos abandonados y recordatorios': 'Abandoned carts and reminders',
  'Catálogo en el chat': 'In-chat catalog', 'Agenda': 'Scheduling', 'Llamadas telefónicas': 'Phone calls', 'SSO con Microsoft': 'Microsoft SSO', 'Evaluaciones': 'Evaluations', 'Facturación CFDI': 'CFDI invoicing',
  'Widget web': 'Web widget', 'Facturación por uso': 'Usage billing', 'Registro de auditoría': 'Audit log', 'Credenciales cifradas': 'Encrypted credentials',
  'Contactos creados automáticamente desde el chat, etiquetas, etapas y notas que lee el agente.': 'Contacts created automatically from chat, tags, stages and notes the agent reads.',
  'Traspaso a una persona, asignación de conversaciones y estados.': 'Handoff to a person, conversation assignment and statuses.', 'Productos, stock y variantes sincronizados con tu tienda.': 'Products, stock and variants synced with your store.',
  'Pedidos creados desde el chat con link de pago.': 'Orders created from chat with a payment link.', 'Mensajes de seguimiento por WhatsApp, solo con plantillas aprobadas por Meta.': 'WhatsApp follow-up messages, only with Meta-approved templates.',
  'Producto, foto y botón de compra dentro de la conversación.': 'Product, photo and buy button inside the conversation.', 'Disponibilidad, citas, recordatorios y cancelaciones.': 'Availability, appointments, reminders and cancellations.',
  'El agente atiende y hace llamadas; la voz la pone ElevenLabs.': 'The agent answers and makes calls; ElevenLabs provides the voice.', 'Inicio de sesión con Microsoft Entra ID (OIDC) para tu empresa.': 'Microsoft Entra ID (OIDC) sign-in for your company.',
  'Preguntas de prueba y porcentaje de acierto antes de publicar un agente.': 'Test questions and accuracy rate before publishing an agent.', 'Facturas electrónicas (CFDI 4.0) de tus pedidos con Facturama.': 'Electronic invoices (CFDI 4.0) for your orders with Facturama.',
  'Chat para incrustar en tu web, con los orígenes permitidos de tu empresa.': "Embeddable chat for your website, with your company's allowed origins.", 'Límites por plan y cobro por conversación. Lo gestiona el superadmin.': 'Plan limits and per-conversation billing. Managed by the superadmin.',
  'Quién cambió qué y cuándo: módulos, roles, usuarios, conexiones, claves e inicios de sesión. Solo lectura.': 'Who changed what and when: modules, roles, users, connections, keys and logins. Read only.',
  'Las credenciales de tus conexiones se guardan cifradas (AES-256-GCM) con una clave propia de tu empresa.': "Your connections' credentials are stored encrypted (AES-256-GCM) with your company's own key.",
  'Solo con plantillas aprobadas por Meta.': 'Only with Meta-approved templates.', 'Solo empresas mexicanas.': 'Mexican companies only.',
  'Crear contactos automáticamente desde el chat': 'Create contacts automatically from chat', 'Etapas del embudo': 'Funnel stages', 'Mensaje al pasar con una persona': 'Message when handing off to a person',
  'Asignar automáticamente (por turnos)': 'Assign automatically (round robin)', 'Aviso de stock bajo (unidades)': 'Low stock alert (units)', 'Sincronizar cada (minutos)': 'Sync every (minutes)',
  'Moneda': 'Currency', 'Pasarela preferida': 'Preferred gateway', 'Recordar carrito abandonado tras (minutos)': 'Remind abandoned cart after (minutes)', 'Plantillas aprobadas por Meta': 'Meta-approved templates',
  'Duración de cada cita (minutos)': 'Appointment length (minutes)', 'Recordatorio antes de la cita (horas)': 'Reminder before the appointment (hours)', 'Zona horaria': 'Time zone',
  'Voz de ElevenLabs (voice_id)': 'ElevenLabs voice (voice_id)', 'Duración máxima de llamada (minutos)': 'Maximum call length (minutes)', 'Directory (tenant) ID de Entra': 'Entra directory (tenant) ID',
  'Dominios de correo permitidos': 'Allowed email domains', 'Acierto mínimo para publicar (%)': 'Minimum accuracy to publish (%)', 'RFC del emisor': 'Issuer RFC', 'Serie': 'Series',
  'Régimen fiscal (clave SAT)': 'Tax regime (SAT code)', 'Orígenes permitidos': 'Allowed origins', 'Color principal': 'Main color', 'Cortar el servicio al superar el límite del plan': 'Cut off service when the plan limit is exceeded',

  // ---------- superadmin ----------
  'Empresas': 'Companies', 'Planes': 'Plans', 'Ajustes': 'Settings', '+ Nueva empresa': '+ New company', 'Nombre de la empresa': 'Company name', 'Identificador (opcional, p. ej. mi-tienda)': 'Identifier (optional, e.g. my-store)',
  'País (MX, ES…)': 'Country (MX, ES…)', 'Email del propietario (se le invita)': "Owner's email (they'll be invited)", 'Crear empresa': 'Create company', 'Coste IA': 'AI cost', 'Cobro estimado': 'Estimated charge',
  'Conversaciones (mes)': 'Conversations (month)', 'Suspendida': 'Suspended', 'Eliminada': 'Deleted', 'Suspender': 'Suspend', 'Reactivar': 'Reactivate', 'Entrar como soporte': 'Enter as support',
  'Coste de IA este mes': 'AI cost this month', 'conversaciones × precio del plan': 'conversations × plan price',
  'Entrar como soporte te da permisos de Admin en esa empresa (sin facturación ni eliminarla) y queda registrado en su auditoría.': "Entering as support gives you Admin permissions in that company (no billing or deletion) and is recorded in its audit log.",
  'Vas a entrar en esta empresa como soporte. Quedará registrado en su auditoría. ¿Continuar?': "You're about to enter this company as support. It will be recorded in its audit log. Continue?",
  '¿Suspender la empresa? Sus usuarios, claves de API, webhooks y automatizaciones dejarán de funcionar hasta reactivarla. No se borra nada.': "Suspend the company? Its users, API keys, webhooks and automations will stop working until it is reactivated. Nothing is deleted.",
  'Los límites vacíos son ilimitados. Quitar un módulo de un plan lo bloquea en las empresas con ese plan, pero no borra sus datos.': "Empty limits are unlimited. Removing a module from a plan blocks it for companies on that plan, but doesn't delete their data.",
  'Nombre del plan': 'Plan name', 'Conversaciones al mes': 'Conversations per month', 'Mensajes de campaña': 'Campaign messages', 'Precio por conversación (USD)': 'Price per conversation (USD)',
  'Guardar plan': 'Save plan', '+ Nuevo plan': '+ New plan', 'plataforma': 'platform', 'Básico': 'Basic', 'Pro': 'Pro', 'Instalación local': 'Local install',
  'Claves de IA': 'AI keys', 'Configurada': 'Set', 'Configurado': 'Set', 'Sin clave': 'No key', 'Guardar claves': 'Save keys',
  'Son las claves con las que das el servicio: todas tus empresas usan estas. Tus clientes no ponen claves. Se guardan cifradas y mandan sobre el .env.': 'These are the keys you provide the service with: all your companies use them. Your customers never enter keys. They are stored encrypted and take precedence over .env.',
  '¿Quitar esta clave? Si no hay otra, el servicio de ese proveedor dejará de funcionar.': "Remove this key? If there's no other, that provider's service will stop working.",
  'Modelo para cada tarea': 'Model for each task', 'Respuestas de los agentes': 'Agent replies', 'Clasificar (temas y textos)': 'Classify (topics and texts)', 'Flujos y asistente': 'Flows and assistant',
  'Respaldo si falla (separados por coma)': 'Fallback if it fails (comma-separated)', 'Guardar modelos': 'Save models', 'Cobro a tus clientes': 'Billing your customers',
  'Tus cuentas de Stripe y Mercado Pago. En Empresas eliges con cuál se cobra a cada cliente.': 'Your Stripe and Mercado Pago accounts. In Companies you choose which one bills each customer.',
  'Stripe: clave secreta': 'Stripe: secret key', 'Stripe: moneda': 'Stripe: currency', 'Mercado Pago: access token': 'Mercado Pago: access token', 'Mercado Pago: moneda': 'Mercado Pago: currency',
  'Página a la que vuelve el cliente tras pagar': 'Page the customer returns to after paying', 'Guardar cobro': 'Save billing', 'Importe': 'Amount', 'Moneda (vacío = la de Ajustes)': 'Currency (empty = the one in Settings)',
  'Concepto (p. ej. Servicio de octubre)': 'Description (e.g. October service)', 'Crear enlace de pago': 'Create payment link', 'Todavía no hay cobros.': 'No charges yet.', 'Copiar enlace': 'Copy link',
  'Comprobar pago': 'Check payment', 'Marcar pagado': 'Mark as paid', '¿Anular este cobro?': 'Cancel this charge?', 'Todavía no consta el pago.': 'The payment has not been recorded yet.',
  'Se crea un enlace de pago con la forma de cobro de la empresa (Stripe o Mercado Pago) y tus credenciales de Ajustes. El Propietario lo ve en Configuración → Facturación.': "A payment link is created with the company's billing method (Stripe or Mercado Pago) and your credentials from Settings. The Owner sees it in Settings → Billing.",

  // ---------- inicio de sesión ----------
  'Bienvenido de nuevo': 'Welcome back', 'Inicia sesión para continuar en Agent Studio.': 'Log in to continue to Agent Studio.', 'Crea tu cuenta': 'Create your account',
  'Crea la cuenta de administrador': 'Create the administrator account', 'Empieza a crear agentes y automatizaciones.': 'Start creating agents and automations.', 'Iniciar sesión': 'Log in',
  'Crear cuenta': 'Create account', 'Entrar': 'Log in', 'Contraseña': 'Password', 'Repite la contraseña': 'Repeat the password', 'Mínimo 8 caracteres.': 'At least 8 characters.',
  'Las contraseñas no coinciden.': "The passwords don't match.", 'La invitación no existe o caducó. Pide una nueva.': "The invitation doesn't exist or has expired. Ask for a new one.",
  '¿No tienes cuenta? Pide una invitación al administrador de tu empresa.': "Don't have an account? Ask your company's administrator for an invitation.",
  'Crea tu cuenta para unirte.': 'Create your account to join.', 'Si ya tienes cuenta, entra para unirte.': 'If you already have an account, log in to join.',
  'Es la primera cuenta: será la propietaria de la empresa principal y administradora de la plataforma.': "It's the first account: it will own the main company and administer the platform.",
  'Email o contraseña incorrectos.': 'Wrong email or password.',

  // ---------- asistente ----------
  '✨ Asistente': '✨ Assistant', 'Asistente de automatización': 'Automation assistant', 'Conecta apps, webhooks, APIs y MCP hablando': 'Connect apps, webhooks, APIs and MCP by chatting',
  'Ej. «añade un aviso por Slack» o «publícalo»': 'E.g. "add a Slack alert" or "publish it"',
  '¡Hola! Dime qué quieres automatizar y lo monto por ti: conecto apps, webhooks, APIs o servidores MCP. Después puedes pedirme cambios hablando.': "Hi! Tell me what you want to automate and I'll build it for you: I connect apps, webhooks, APIs or MCP servers. Then you can ask me for changes by chatting.",

  // ---------- mensajes frecuentes del servidor ----------
  'No tienes permiso para esto.': "You don't have permission to do this.", 'Inicia sesión para continuar': 'Log in to continue', 'Ruta no encontrada': 'Route not found',
  'Solo el administrador de la plataforma puede hacer esto.': 'Only the platform administrator can do this.', 'Origen no permitido': 'Origin not allowed',
  'No perteneces a ninguna empresa todavía. Pide una invitación a su administrador.': "You don't belong to any company yet. Ask its administrator for an invitation.",
  'La empresa está suspendida. Contacta con el administrador de la plataforma.': 'The company is suspended. Contact the platform administrator.',
  'El email no es válido.': 'The email is not valid.', 'Ese usuario ya pertenece a la empresa.': 'That user already belongs to the company.',
  'No puedes desactivarte a ti mismo.': "You can't disable yourself.", 'Escribe un importe mayor que 0.': 'Enter an amount greater than 0.',
  // ---------- textos partidos por etiquetas (código, negritas) ----------
  'Conecta tus agentes y automatizaciones con': 'Connect your agents and automations with', 'apps: integraciones nativas, APIs REST y servidores MCP.': 'apps: native integrations, REST APIs and MCP servers.',
  ': conectan con casi cualquier servicio.': ': they connect with almost any service.', 'No hay coincidencias. Prueba': 'No matches. Try', 'No hay coincidencias. Prueba con el módulo': 'No matches. Try the module', 'o': 'or',
  'Pega la URL de un archivo de módulo (': 'Paste the URL of a module file (', ', por ejemplo el enlace "raw" de GitHub). Para crear el tuyo, copia': ', e.g. the GitHub "raw" link). To create your own, copy',
  'y sigue': 'and follow', '. El catálogo de APIs y MCP se regenera con': '. The API and MCP catalog is regenerated with',
  'La araña recorre el flujo de un mensaje según estas métricas: tarda más donde hay más latencia, se mueve según la p50, sus patas son agentes y conversaciones, y su núcleo se pone rojo si se rompe el SLA.': 'The spider walks a message’s path according to these metrics: it lingers where latency is higher, moves at the p50, its legs are agents and conversations, and its core turns red if the SLA is broken.',
  'Agente en vivo según las métricas': 'Live agent from the metrics',
  'Cada clave es de tu empresa y solo puede hacer lo que marques al crearla (sus': 'Each key belongs to your company and can only do what you tick when creating it (its', '). Envíala como': '). Send it as',
  '. En los ejemplos, cambia': '. In the examples, replace', 'por la tuya.': 'with yours.', 'Base URL': 'Base URL', 'y': 'and',
  '= id del agente. Sirve para n8n, Make, LangChain, apps de chat…': '= agent id. Works with n8n, Make, LangChain, chat apps…',
  'En Copilot Studio: agrega tu agente a una': 'In Copilot Studio: add your agent to a', 'Solución': 'Solution', '→ en Power Apps ve a': '→ in Power Apps go to', 'Soluciones → Exportar': 'Solutions → Export',
  '(no administrada). Sube aquí el .zip.': '(unmanaged). Upload the .zip here.', 'En un tema de Copilot Studio: menú': 'In a Copilot Studio topic: menu', '⋯ → Abrir editor de código': '⋯ → Open code editor',
  ', copia todo y pégalo aquí.': ', copy everything and paste it here.', 'Edita el agente en YAML:': 'Edit the agent in YAML:', '(temas con pasos),': '(topics with steps),',
  'Cuando un agente escale crea un ticket en Zendesk': 'When an agent escalates, create a Zendesk ticket', 'ninguno en .env': 'none in .env', 'Para': 'For',
  ', el endpoint compatible con OpenAI y': ', the OpenAI-compatible endpoint and', '. La clave solo podrá hacer lo que marques (y nunca más de lo que puedes hacer tú). La verás una sola vez.': ". The key can only do what you tick (and never more than you can). You'll see it only once.",
  'ℹ Solo con plantillas aprobadas por Meta.': 'ℹ Only with Meta-approved templates.', 'ℹ Solo empresas mexicanas.': 'ℹ Mexican companies only.', '🔒 No incluido en tu plan': '🔒 Not included in your plan', '🔒 No disponible': '🔒 Not available',
  '). Vacío = lo del .env. En «Clasificar»,': '). Empty = the .env value. In "Classify",', 'usa el modelo más barato que tenga clave.': 'uses the cheapest model that has a key.',
  '🛟 Modo soporte en': '🛟 Support mode in', 'Escribe': 'Write', '(p. ej.': '(e.g.', 'https://tu-dominio.com/gracias': 'https://your-domain.com/thanks', 'Gestionar claves de API ': 'Manage API keys',
  'Comunicación': 'Communication', 'Analítica': 'Analytics', 'Básicos': 'Basics', 'Mensajería': 'Messaging', 'APIs públicas': 'Public APIs', 'Comercio': 'Commerce', 'Productividad': 'Productivity', 'Desarrollo': 'Development', 'Formularios': 'Forms', 'IA': 'AI',
};

// Comienzos de frase con una parte variable detrás (el resto se deja tal cual)
const PREFIX = [
  ['Hola, ', 'Hi, '], ['Tema: ', 'Topic: '], ['Fuentes: ', 'Sources: '], ['Última prueba: ', 'Last test: '], ['Última ejecución: ', 'Last run: '], ['Modelo por defecto: ', 'Default model: '],
  ['Comparte este enlace con ', 'Share this link with '], ['✔ Invitación enviada a ', '✔ Invitation sent to '], ['Cobros a ', 'Charges to '], ['Requiere conectar: ', 'Needs connecting: '],
  ['Requiere activar: ', 'Needs enabling: '], ['No incluido en el plan ', 'Not included in plan '], ['Tu plan permite ', 'Your plan allows '], ['Te invitaron a ', 'You were invited to '],
  ['No tienes permiso para esto ', "You don't have permission for this "], ['Modelos: ', 'Models: '], ['Límite: ', 'Limit: '], ['Actualizado ', 'Updated '], ['Clonar «', 'Clone "'],
  ['¿Eliminar "', 'Delete "'], ['¿Desconectar ', 'Disconnect '], ['¿Desinstalar el módulo "', 'Uninstall the module "'], ['Micrófono: ', 'Microphone: '], ['No hay acceso al micrófono: ', 'No microphone access: '],
  ['Voz: ', 'Voice: '], ['Backend: directo', 'Backend: direct'], ['Clasificar: ', 'Classify: '], ['Proveedores: ', 'Providers: '], ['Voz ElevenLabs: ', 'ElevenLabs voice: '],
  ['🛟 Modo soporte en ', '🛟 Support mode in '], ['Sus webhooks: ', 'Its webhooks: '], ['Para activar ', 'To enable '], ['Estos módulos dependen de ', 'These modules depend on '],
];

// Frases con partes variables en medio
const PATTERNS = [
  [/^(\d+) de (\d+) registros$/, '$1 of $2 records'], [/^(\d+) permisos$/, '$1 permissions'], [/^(\d+) (apps?)( en (.+))?$/, (m, n, a, _x, cat) => `${n} ${a}${cat ? ` in ${cat}` : ''}`],
  [/^(\d+) acci(ón|ones)$/, (m, n) => `${n} action${n === '1' ? '' : 's'}`], [/^(.+) no está incluido en tu plan\.$/, '$1 is not included in your plan.'], [/^(.+) está desactivado en tu empresa\.$/, '$1 is disabled in your company.'],
  [/^(.+) requiere configuración: (.+)$/, '$1 needs setup: $2'], [/^Tu plan \((.+)\) permite (\d+) (usuarios|agentes)\. Mejora el plan para (invitar a más|crear más)\.$/, (m, p, n, w) => `Your plan (${p}) allows ${n} ${w === 'usuarios' ? 'users' : 'agents'}. Upgrade the plan to add more.`],
  [/^No puedes quitarle el rol al último Propietario\..*$/, "You can't remove the role from the last Owner. Appoint another Owner first."], [/^No puedes dar permisos que no tienes: (.+)$/, "You can't grant permissions you don't have: $1"],
  [/^Para activar (.+) también hay que activar: (.+)\.\n\n¿Activarlos juntos\?$/, 'To enable $1 you also need to enable: $2.\n\nEnable them together?'],
  [/^Estos módulos dependen de (.+) y también se desactivarán: (.+)\.\n\nSus datos no se borran\. ¿Continuar\?$/, "These modules depend on $1 and will also be disabled: $2.\n\nTheir data isn't deleted. Continue?"],
  [/^Hola, (.+)\. ¿Listo para$/, 'Hi, $1. Ready to'], [/^Hola, ¿listo para$/, 'Hi, ready to'], [/^Empresa «(.+)» creada\.$/, 'Company "$1" created.'],
  [/^Solo para empresas de (.+)$/, 'Only for companies in $1'], [/^Indica el país de la empresa \((.+)\)$/, "Set the company's country ($1)"],
  [/^Comparte con (.+) el enlace para ser Propietario:$/, 'Share with $1 the link to become Owner:'], [/^\(caduca en (\d+) días\):$/, '(expires in $1 days):'],
  [/^con el rol$/, 'with the role'],
  [/^Updated (.+)\. Coste estimado con .*$/, 'Updated $1. Cost estimated with each model\'s prices (src/llm-providers.ts, adjustable with LLM_PRICES) and the MONTHLY_BUDGET_USD budget.'],
  [/^Actualizado (.+)\. Coste estimado con .*$/, 'Updated $1. Cost estimated with each model\'s prices (src/llm-providers.ts, adjustable with LLM_PRICES) and the MONTHLY_BUDGET_USD budget.'],
  [/^No hay correo configurado: al invitar verás un enlace para compartirlo tú\. Tu plan permite (\d+) usuarios \((\d+) activos\)\.$/, "No email is set up: when you invite, you'll see a link to share yourself. Your plan allows $1 users ($2 active)."],
  [/^Le enviaremos un correo con el enlace de invitación\. Tu plan permite (\d+) usuarios \((\d+) activos\)\.$/, "We'll email them the invitation link. Your plan allows $1 users ($2 active)."],
  [/^API de (.+)$/, '$1 API'],
  [/^([\w-]+(?: o [\w-]+)+)$/, (m) => m.replace(/ o /g, ' or ')], // "shopify o woocommerce" [/^El servicio de IA no está configurado\..*$/, 'The AI service is not set up. The platform administrator must add a DeepSeek, Qwen or other provider key (Companies and plans → Settings).'],
];

let lang = 'es';
const missing = new Set();
// #options: opciones que el agente ofrece en el chat (se envían tal cual al pulsarlas)
const SKIP = 'textarea, pre, code, script, style, .msg, .snip, #options, [data-no-i18n]';

export function translateText(text) {
  if (lang !== 'en' || !text) return text;
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  const core = text.trim().replace(/\s+/g, ' ');
  if (!core || !/[a-záéíóúñ]{2,}/i.test(core)) return text;
  if (EXACT[core] !== undefined) return lead + EXACT[core] + trail;
  for (const [re, to] of PATTERNS) if (re.test(core)) return lead + core.replace(re, to) + trail;
  for (const [from, to] of PREFIX) if (core.startsWith(from)) return lead + to + core.slice(from.length) + trail;
  if (/[áéíóúñ¿¡]|\b(el|la|los|las|de|del|una?|que|para|con|por|sin|tus?|es|en|al)\b/i.test(core)) missing.add(core);
  return text;
}

// Varias líneas (alert/confirm): se traduce entero y, si no, línea a línea
const translateMessage = (m) => {
  const s = String(m ?? '');
  const whole = translateText(s);
  return whole !== s ? whole : s.split('\n').map((l) => translateText(l)).join('\n');
};

const ATTRS = ['placeholder', 'title', 'aria-label'];

function translateNode(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.parentElement && !root.parentElement.closest(SKIP)) {
      const t = translateText(root.data);
      if (t !== root.data) root.data = t;
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || root.closest(SKIP)) return;
  const els = [root, ...root.querySelectorAll('*')];
  for (const el of els) {
    if (el.closest(SKIP)) continue;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) { const t = translateText(v); if (t !== v) el.setAttribute(a, t); }
    }
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) { const t = translateText(n.data); if (t !== n.data) n.data = t; }
  }
}

let observer = null;

export function setLanguage(next) {
  lang = next === 'en' ? 'en' : 'es';
  document.documentElement.lang = lang;
  try { localStorage.setItem('as-lang', lang); } catch {}
  if (lang !== 'en') return;
  window.__untranslated = missing;
  translateNode(document.body);
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateNode(r.target);
      else if (r.type === 'attributes') translateNode(r.target);
      else r.addedNodes.forEach(translateNode);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const { alert, confirm, prompt } = window;
  window.alert = (m) => alert(translateMessage(m));
  window.confirm = (m) => confirm(translateMessage(m));
  window.prompt = (m, d) => prompt(translateMessage(m), d);
}

// Antes de iniciar sesión no hay empresa: se usa el último idioma o el del navegador
export function initialLanguage() {
  try { const saved = localStorage.getItem('as-lang'); if (saved) return saved; } catch {}
  return (navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'es';
}

export const currentLanguage = () => lang;
