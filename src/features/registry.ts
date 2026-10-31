// Registro de módulos de negocio ("features") que se activan por empresa.
//
// Cada módulo es una definición declarativa: qué permisos aporta, de qué otros
// módulos depende, qué conexiones (apps de modules/apps) necesita, qué
// herramientas ve el agente, qué pasos de automatización y qué entradas del
// menú controla. La lógica de cada módulo se conecta después sobre esta base
// (ver FEATURES.md).
//
// Ojo: no confundir con los "módulos" de src/modules/ (las apps de los flujos).

export type FeatureGroup = 'ecommerce' | 'reservas' | 'empresa' | 'monetizacion';
export type FeatureScope = 'tenant' | 'platform';

// JSON Schema (subconjunto) para la configuración del módulo por empresa
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  format?: 'uri' | 'email';
  additionalProperties?: boolean;
}

export interface FeatureDef {
  key: string; // identificador estable
  name: string;
  description: string;
  group: FeatureGroup;
  toggleable: boolean; // false = siempre activo (base de seguridad)
  scope: FeatureScope; // platform = solo lo gestiona el superadmin
  dependsOn: string[];
  // Apps de modules/apps que deben estar conectadas. Un grupo ["a", "b"]
  // significa "al menos una de ellas".
  requiredConnections: (string | string[])[];
  permissions: string[]; // formato modulo.recurso.accion
  agentTools: string[]; // herramientas que el LLM ve solo si el módulo está activo y configurado
  flowModules: string[]; // pasos de automatización "<módulo>.<acción|*>"
  navItems: string[]; // entradas del menú de la interfaz
  configSchema: JsonSchema;
  defaultEnabled: boolean;
  notes?: string;
  countries?: string[]; // si se limita a ciertos países (ISO 3166-1 alfa-2)
}

export const GROUPS: Record<FeatureGroup, string> = {
  ecommerce: 'E-commerce y WhatsApp',
  reservas: 'Reservas y voz',
  empresa: 'Empresa',
  monetizacion: 'Monetización',
};

const def = (f: Partial<FeatureDef> & Pick<FeatureDef, 'key' | 'name' | 'description' | 'group'>): FeatureDef => ({
  toggleable: true,
  scope: 'tenant',
  dependsOn: [],
  requiredConnections: [],
  permissions: [],
  agentTools: [],
  flowModules: [],
  navItems: [],
  configSchema: { type: 'object', properties: {} },
  defaultEnabled: false,
  ...f,
});

export const FEATURES: FeatureDef[] = [
  def({
    key: 'crm', name: 'Mini CRM', group: 'ecommerce',
    description: 'Contactos creados automáticamente desde el chat, etiquetas, etapas y notas que lee el agente.',
    permissions: ['crm.contacts.read', 'crm.contacts.write', 'crm.contacts.delete', 'crm.notes.write', 'crm.tags.manage', 'crm.stages.manage'],
    agentTools: ['crm_lookup_contact', 'crm_upsert_contact', 'crm_add_note'],
    flowModules: ['crm.*'],
    navItems: ['/crm'],
    configSchema: {
      type: 'object',
      properties: {
        autoCreateContacts: { type: 'boolean', title: 'Crear contactos automáticamente desde el chat', default: true },
        stages: { type: 'array', title: 'Etapas del embudo', items: { type: 'string', maxLength: 40 }, maxItems: 20, default: ['Nuevo', 'Interesado', 'Cliente'] },
      },
    },
  }),
  def({
    key: 'web_store', name: 'Web y tienda', group: 'ecommerce',
    description: 'Página web con plantillas de la plataforma, catálogo de productos y compra online con Stripe o Mercado Pago (el dinero va a tu cuenta).',
    permissions: ['web_store.site.read', 'web_store.site.write', 'web_store.products.read', 'web_store.products.write', 'web_store.orders.read', 'web_store.payments.manage'],
    navItems: ['/web'],
  }),
  def({
    key: 'inbox', name: 'Bandeja compartida', group: 'ecommerce',
    description: 'Traspaso a una persona, asignación de conversaciones y estados.',
    dependsOn: ['crm'],
    permissions: ['inbox.conversations.read', 'inbox.conversations.reply', 'inbox.conversations.assign', 'inbox.conversations.close'],
    agentTools: ['inbox_handoff_to_human'],
    flowModules: ['inbox.*'],
    navItems: ['/inbox'],
    configSchema: {
      type: 'object',
      properties: {
        handoffMessage: { type: 'string', title: 'Mensaje al pasar con una persona', maxLength: 300, default: 'Te paso con una persona del equipo.' },
        autoAssign: { type: 'boolean', title: 'Asignar automáticamente (por turnos)', default: false },
      },
    },
  }),
  def({
    key: 'inventory', name: 'Inventario ligero', group: 'ecommerce',
    description: 'Productos, stock y variantes sincronizados con tu tienda.',
    requiredConnections: [['shopify', 'woocommerce']],
    permissions: ['inventory.products.read', 'inventory.products.write', 'inventory.stock.write'],
    agentTools: ['inventory_search_products', 'inventory_check_stock'],
    flowModules: ['inventory.*'],
    navItems: ['/inventory'],
    configSchema: {
      type: 'object',
      properties: {
        lowStockThreshold: { type: 'integer', title: 'Aviso de stock bajo (unidades)', minimum: 0, maximum: 100000, default: 5 },
        syncEveryMinutes: { type: 'integer', title: 'Sincronizar cada (minutos)', minimum: 5, maximum: 1440, default: 60 },
      },
    },
  }),
  def({
    key: 'orders', name: 'Pedidos y pagos', group: 'ecommerce',
    description: 'Pedidos creados desde el chat con link de pago.',
    dependsOn: ['inventory', 'crm'],
    requiredConnections: [['mercadopago', 'stripe']],
    permissions: ['orders.orders.read', 'orders.orders.create', 'orders.orders.update', 'orders.payments.create', 'orders.payments.refund'],
    agentTools: ['orders_create_order', 'orders_payment_link', 'orders_order_status'],
    flowModules: ['orders.*'],
    navItems: ['/orders'],
    configSchema: {
      type: 'object',
      properties: {
        currency: { type: 'string', title: 'Moneda', enum: ['MXN', 'USD', 'EUR', 'COP', 'ARS', 'CLP', 'PEN'], default: 'MXN' },
        paymentProvider: { type: 'string', title: 'Pasarela preferida', enum: ['mercadopago', 'stripe'], default: 'mercadopago' },
      },
    },
  }),
  def({
    key: 'campaigns', name: 'Carritos abandonados y recordatorios', group: 'ecommerce',
    description: 'Mensajes de seguimiento por WhatsApp, solo con plantillas aprobadas por Meta.',
    dependsOn: ['orders', 'crm'],
    requiredConnections: ['whatsapp'],
    permissions: ['campaigns.campaigns.read', 'campaigns.campaigns.write', 'campaigns.campaigns.send'],
    flowModules: ['campaigns.*'],
    navItems: ['/campaigns'],
    notes: 'Solo con plantillas aprobadas por Meta.',
    configSchema: {
      type: 'object',
      properties: {
        abandonedCartDelayMinutes: { type: 'integer', title: 'Recordar carrito abandonado tras (minutos)', minimum: 15, maximum: 10080, default: 60 },
        approvedTemplates: { type: 'array', title: 'Plantillas aprobadas por Meta', items: { type: 'string', maxLength: 120 }, maxItems: 50, default: [] },
      },
    },
  }),
  def({
    key: 'chat_catalog', name: 'Catálogo en el chat', group: 'ecommerce',
    description: 'Producto, foto y botón de compra dentro de la conversación.',
    dependsOn: ['inventory'],
    requiredConnections: ['whatsapp'],
    permissions: ['chat_catalog.catalog.read', 'chat_catalog.catalog.write'],
    agentTools: ['chat_catalog_send_product'],
    flowModules: ['chat-catalog.*'],
    navItems: ['/catalog'],
  }),
  def({
    key: 'scheduling', name: 'Agenda', group: 'reservas',
    description: 'Disponibilidad, citas, recordatorios y cancelaciones.',
    dependsOn: ['crm'],
    requiredConnections: ['google-calendar'],
    permissions: ['scheduling.appointments.read', 'scheduling.appointments.create', 'scheduling.appointments.cancel', 'scheduling.availability.manage'],
    agentTools: ['scheduling_check_availability', 'scheduling_book_appointment', 'scheduling_cancel_appointment'],
    flowModules: ['scheduling.*'],
    navItems: ['/scheduling'],
    configSchema: {
      type: 'object',
      properties: {
        slotMinutes: { type: 'integer', title: 'Duración de cada cita (minutos)', minimum: 5, maximum: 480, default: 30 },
        reminderHours: { type: 'integer', title: 'Recordatorio antes de la cita (horas)', minimum: 0, maximum: 168, default: 24 },
        timezone: { type: 'string', title: 'Zona horaria', maxLength: 60, default: 'America/Mexico_City' },
      },
    },
  }),
  def({
    key: 'voice_calls', name: 'Llamadas telefónicas', group: 'reservas',
    description: 'El agente atiende y hace llamadas; la voz la pone ElevenLabs.',
    requiredConnections: ['twilio'],
    permissions: ['voice_calls.calls.read', 'voice_calls.calls.create', 'voice_calls.numbers.manage'],
    agentTools: ['voice_calls_start_call'],
    flowModules: ['voice-calls.*'],
    navItems: ['/calls'],
    configSchema: {
      type: 'object',
      properties: {
        voiceId: { type: 'string', title: 'Voz de ElevenLabs (voice_id)', maxLength: 64 },
        maxCallMinutes: { type: 'integer', title: 'Duración máxima de llamada (minutos)', minimum: 1, maximum: 120, default: 10 },
      },
    },
  }),
  def({
    key: 'sso_microsoft', name: 'SSO con Microsoft', group: 'empresa',
    description: 'Inicio de sesión con Microsoft Entra ID (OIDC) para tu empresa.',
    permissions: ['sso_microsoft.settings.read'],
    configSchema: {
      type: 'object',
      properties: {
        entraTenantId: { type: 'string', title: 'Directory (tenant) ID de Entra', pattern: '^[0-9a-fA-F-]{36}$' },
        clientId: { type: 'string', title: 'Application (client) ID', pattern: '^[0-9a-fA-F-]{36}$' },
        allowedDomains: { type: 'array', title: 'Dominios de correo permitidos', items: { type: 'string', maxLength: 120 }, maxItems: 20, default: [] },
      },
    },
  }),
  def({
    key: 'evals', name: 'Evaluaciones', group: 'empresa',
    description: 'Preguntas de prueba y porcentaje de acierto antes de publicar un agente.',
    permissions: ['evals.suites.read', 'evals.suites.write', 'evals.runs.create'],
    flowModules: ['evals.*'],
    navItems: ['/evals'],
    configSchema: {
      type: 'object',
      properties: { minScoreToPublish: { type: 'integer', title: 'Acierto mínimo para publicar (%)', minimum: 0, maximum: 100, default: 80 } },
    },
  }),
  def({
    key: 'cfdi', name: 'Facturación CFDI', group: 'monetizacion',
    description: 'Facturas electrónicas (CFDI 4.0) de tus pedidos con Facturama.',
    dependsOn: ['orders'],
    requiredConnections: ['facturama'],
    permissions: ['cfdi.invoices.read', 'cfdi.invoices.create', 'cfdi.invoices.cancel'],
    agentTools: ['cfdi_request_invoice'],
    flowModules: ['cfdi.*'],
    navItems: ['/cfdi'],
    countries: ['MX'],
    notes: 'Solo empresas mexicanas.',
    configSchema: {
      type: 'object',
      properties: {
        rfcEmisor: { type: 'string', title: 'RFC del emisor', pattern: '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$' },
        serie: { type: 'string', title: 'Serie', maxLength: 10, default: 'A' },
        regimenFiscal: { type: 'string', title: 'Régimen fiscal (clave SAT)', pattern: '^[0-9]{3}$' },
      },
    },
  }),
  def({
    key: 'web_widget', name: 'Widget web', group: 'monetizacion',
    description: 'Chat para incrustar en tu web, con los orígenes permitidos de tu empresa.',
    permissions: ['web_widget.widgets.read', 'web_widget.widgets.write'],
    navItems: ['/widget'],
    configSchema: {
      type: 'object',
      properties: {
        allowedOrigins: { type: 'array', title: 'Orígenes permitidos', items: { type: 'string', format: 'uri', maxLength: 200 }, maxItems: 30, default: [] },
        primaryColor: { type: 'string', title: 'Color principal', pattern: '^#[0-9a-fA-F]{6}$', default: '#4f46e5' },
      },
    },
  }),
  def({
    key: 'usage_billing', name: 'Facturación por uso', group: 'monetizacion', scope: 'platform',
    description: 'Límites por plan y cobro por conversación. Lo gestiona el superadmin.',
    permissions: ['usage_billing.usage.read'],
    configSchema: {
      type: 'object',
      properties: { hardLimit: { type: 'boolean', title: 'Cortar el servicio al superar el límite del plan', default: false } },
    },
  }),
  def({
    key: 'audit_log', name: 'Registro de auditoría', group: 'empresa', toggleable: false, defaultEnabled: true,
    description: 'Quién cambió qué y cuándo: módulos, roles, usuarios, conexiones, claves e inicios de sesión. Solo lectura.',
    navItems: ['/settings/audit'],
  }),
  def({
    key: 'encrypted_credentials', name: 'Credenciales cifradas', group: 'empresa', toggleable: false, defaultEnabled: true,
    description: 'Las credenciales de tus conexiones se guardan cifradas (AES-256-GCM) con una clave propia de tu empresa.',
  }),
];

const byKey = new Map(FEATURES.map((f) => [f.key, f]));

export function getFeature(key: string): FeatureDef | undefined {
  return byKey.get(key);
}

export function featureKeys(): string[] {
  return FEATURES.map((f) => f.key);
}

// Módulos que dependen (directa o indirectamente) de key
export function dependentsOf(key: string): string[] {
  const out = new Set<string>();
  const walk = (k: string) => {
    for (const f of FEATURES) if (f.dependsOn.includes(k) && !out.has(f.key)) { out.add(f.key); walk(f.key); }
  };
  walk(key);
  return [...out];
}

// Dependencias (directas e indirectas) de key, en orden de activación
export function dependenciesOf(key: string): string[] {
  const out: string[] = [];
  const walk = (k: string, seen: Set<string>) => {
    for (const d of getFeature(k)?.dependsOn ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      walk(d, seen);
      if (!out.includes(d)) out.push(d);
    }
  };
  walk(key, new Set([key]));
  return out;
}

// ¿Este paso de automatización (módulo de flujo + acción) pertenece a un feature?
export function featureForFlowStep(moduleKey: string, actionKey = '*'): FeatureDef | undefined {
  return FEATURES.find((f) => f.flowModules.some((p) => {
    const [m, a = '*'] = p.split('.');
    return m === moduleKey && (a === '*' || a === actionKey);
  }));
}

export function featureForAgentTool(tool: string): FeatureDef | undefined {
  return FEATURES.find((f) => f.agentTools.includes(tool));
}

// Validación del propio registro (claves únicas, dependencias existentes, sin ciclos,
// permisos con el prefijo del módulo). La comprueba test/features.test.ts.
export function validateRegistry(list: FeatureDef[] = FEATURES): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const f of list) {
    if (!/^[a-z][a-z0-9_]*$/.test(f.key)) errors.push(`${f.key}: clave inválida`);
    if (keys.has(f.key)) errors.push(`${f.key}: clave duplicada`);
    keys.add(f.key);
  }
  for (const f of list) {
    for (const d of f.dependsOn) if (!keys.has(d)) errors.push(`${f.key}: depende de "${d}", que no existe`);
    for (const p of f.permissions) if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(p) || !p.startsWith(`${f.key}.`)) errors.push(`${f.key}: permiso "${p}" no sigue modulo.recurso.accion`);
    if (!f.toggleable && f.dependsOn.length) errors.push(`${f.key}: un módulo no desactivable no puede tener dependencias`);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (k: string, path: string[]) => {
    if (done.has(k)) return;
    if (visiting.has(k)) { errors.push(`ciclo de dependencias: ${[...path, k].join(' → ')}`); return; }
    visiting.add(k);
    for (const d of list.find((x) => x.key === k)?.dependsOn ?? []) visit(d, [...path, k]);
    visiting.delete(k);
    done.add(k);
  };
  for (const f of list) visit(f.key, []);
  return errors;
}
