# Módulos de negocio activables (features)

Un **módulo de negocio** (CRM, agenda, pedidos…) es una funcionalidad que cada empresa activa o desactiva y cuya disponibilidad depende de su plan. Esta base ya resuelve el registro, la activación con dependencias, la configuración por empresa y la aplicación de las reglas en todos los canales. Cada módulo solo tiene que declarar qué necesita y enchufar su lógica.

> No confundir con los *módulos de automatización* de `modules/` (apps para los flujos, ver [MODULES.md](MODULES.md)). Un módulo de negocio puede, además, aportar pasos de flujo.

## Cómo se decide si algo se puede usar

Todo pasa por `can(ctx, { feature, permission })` en `src/authz/can.ts`, en este orden:

1. La empresa está activa (no suspendida).
2. **Plan**: el módulo está en `plan_features` del plan de la empresa.
3. **Empresa**: el admin lo activó (`tenant_features.enabled`).
4. **Rol**: el usuario o la clave de API tiene el permiso.
5. **Dependencias**: los módulos de `dependsOn` están activos y sus `requiredConnections` conectadas. Si no, el módulo queda en **«Requiere configuración»** y sigue bloqueado.

El estado de cada módulo por empresa lo calcula `src/features/state.ts` (con una caché corta que se vacía al guardar).

## 1. Registrar el módulo

Añade (o completa) su definición en `src/features/registry.ts`:

```ts
def({
  key: 'crm',                         // estable: no lo cambies nunca
  name: 'Mini CRM',
  description: 'Contactos, etiquetas, etapas y notas.',
  group: 'ecommerce',                 // ecommerce | reservas | empresa | monetizacion
  toggleable: true,                   // false = siempre activo (solo para seguridad)
  scope: 'tenant',                    // 'platform' = solo lo gestiona el superadmin
  dependsOn: [],                      // otros módulos
  requiredConnections: [],            // apps de modules/apps; ['a', 'b'] dentro de la lista = "a o b"
  permissions: ['crm.contacts.read', 'crm.contacts.write'],   // modulo.recurso.accion
  agentTools: ['crm_lookup_contact'], // herramientas que verá el LLM
  flowModules: ['crm.*'],             // pasos de flujo "<módulo>.<acción|*>"
  navItems: ['/crm'],                 // entradas del menú
  configSchema: { type: 'object', properties: { autoCreateContacts: { type: 'boolean', default: true } } },
  defaultEnabled: false,
})
```

Reglas que comprueba `test/features.test.ts` (`validateRegistry()`): clave única en `snake_case`, dependencias que existen y sin ciclos, permisos con el prefijo del módulo.

Los permisos nuevos aparecen solos en la matriz de roles. Los roles del sistema se calculan en código (`src/authz/permissions.ts`): *Propietario* y *Admin* los reciben todos, *Solo lectura* los `*.read` y *Operador* todos salvo `*.manage` y `*.delete`.

**Planes**: un módulo nuevo no está en ningún plan existente. Añádelo desde **Empresas y planes** o con una migración (siguiente paso).

## 2. Tablas y migración

Añade una migración nueva al final de `MIGRATIONS` en `src/db/migrations.ts` (no edites las anteriores). Debe ser idempotente (`CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`…).

Toda tabla de negocio lleva `tenant_id INT UNSIGNED NOT NULL` con índice y clave foránea a `tenants`:

```ts
{
  version: 5,
  name: 'crm: contactos',
  async up(c) {
    await c.query(`CREATE TABLE IF NOT EXISTS crm_contacts (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT UNSIGNED NOT NULL,
      email VARCHAR(190) NULL,
      name VARCHAR(120) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX (tenant_id), UNIQUE (tenant_id, email),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    // Incluirlo en el plan "empresa"
    await c.query("INSERT IGNORE INTO plan_features (plan_id, feature_key) SELECT id, 'crm' FROM plans WHERE plan_key = 'empresa'");
  },
}
```

Y añade la tabla a `TENANT_TABLES` en `src/db/tenant-db.ts`.

## 3. Consultas: siempre con `tenantDb()`

Nunca uses `db().query()` para datos de una empresa. `tenantDb(id)` exige el marcador `:tenant` y lo sustituye por el id:

```ts
import { tenantDb } from '../db/tenant-db.ts';

const t = tenantDb(ctx.tenantId);
await t.query('SELECT * FROM crm_contacts WHERE tenant_id = :tenant AND email = ?', [email]);
await t.query('INSERT INTO crm_contacts (tenant_id, email, name) VALUES (:tenant, ?, ?)', [email, name]);
```

`test/tenant-db.test.ts` lee todo `src/` y falla si alguna consulta a una tabla de `TENANT_TABLES` no lleva `:tenant`. Los archivos en disco van siempre por `tenantDataPath(tenantId, ...)` de `src/tenancy/paths.ts`.

**Desactivar un módulo no borra nada**: no borres datos al desactivar. Si tienes trabajo en curso (p. ej. campañas), escucha el evento y páusalo:

```ts
import { featureEvents } from '../features/state.ts';
featureEvents.on('disabled', ({ tenantId, features }) => { if (features.includes('campaigns')) pausarCampañas(tenantId); });
```

## 4. Rutas de la interfaz (`/api`)

Regístralas con la tabla de rutas de `src/http.ts`. El middleware comprueba `can()` antes de llamar al handler, así que con el módulo desactivado responden **403** solas:

```ts
import { route, send, json, requireFeature } from '../http.ts';

route('GET', '/api/crm/contacts', requireFeature('crm', 'crm.contacts.read'), async (req, res, _p, ctx) => {
  send(res, 200, await listContacts(ctx.tenantId));
});
route('POST', '/api/crm/contacts', requireFeature('crm', 'crm.contacts.write'), async (req, res, _p, ctx) => {
  const contact = await createContact(ctx.tenantId, await json(req));
  await audit({ tenantId: ctx.tenantId, actor: ctx.actor, ip: ctx.ip, action: 'crm.contact_created', target: `contact:${contact.id}`, after: contact });
  send(res, 201, contact);
});
```

`ctx` (`src/authz/context.ts`) trae `tenantId`, `tenant`, `plan`, `user`, `role`, `permissions`, `actor` (para la auditoría) e `ip`. Registra las rutas importando tu archivo desde `src/server.ts`.

## 5. API pública (`/v1`) y MCP

En `src/public-api.ts`, cada ruta llama a `allow(permiso, feature)` antes de responder; las claves de API solo tienen los permisos de sus *scopes*. En `src/mcp.ts`, registra las herramientas con `tool(nombre, permiso, definición, run)` y, si dependen de un módulo, comprueba `await assertCan(ctx, { feature: 'crm', permission: '...' })` dentro de `run`.

## 6. Herramientas del agente

Implementa cada nombre de `agentTools` y regístralo (por ejemplo, en el archivo del módulo):

```ts
import { registerAgentTool } from '../features/enforce.ts';

registerAgentTool('crm', {
  name: 'crm_lookup_contact',
  description: 'Busca un contacto por email o teléfono',
  parameters: { type: 'object', properties: { email: { type: 'string' } } },
  run: async ({ tenantId, agentId, sessionId, args }) => findContact(tenantId, String(args.email)),
});
```

El motor (`src/engine.ts`) solo pasa al LLM las herramientas de módulos **activos y configurados** de la empresa del agente. Si el modelo pide una herramienta bloqueada (o inexistente) de un módulo, se rechaza y queda en la auditoría como `agent.tool_blocked`.

## 7. Pasos de automatización

Crea un módulo de flujo con la clave de `flowModules` (p. ej. `modules/crm/index.ts` con `key: 'crm'`, ver [MODULES.md](MODULES.md)). Las claves de módulo de flujo no admiten `_`: por eso `chat_catalog` usa `chat-catalog.*` y `voice_calls`, `voice-calls.*`. Usa `ctx.tenant.id` para sus consultas. Sin más código:

- El editor oculta sus pasos si el módulo no está activo (`filterModulesForTenant`).
- Un flujo que los use falla con un error claro **sin ejecutar ningún paso** (`blockedFlowFeatures` en `runFlow`).
- Si es programado o de sondeo, queda **en pausa** y se reanuda solo al reactivar el módulo.
- Su webhook responde 403 y se audita (`webhook.blocked`).

## 8. Interfaz

`GET /api/me/context` devuelve los permisos, el estado de cada módulo y `nav` (los `navItems` de los módulos activos). En `public/context.js` tienes `can('crm.contacts.write')` y `featureOn('crm')` para mostrar u ocultar menús y botones. La tarjeta del módulo en **Configuración → Módulos** (interruptor, dependencias, conexiones y formulario de `configSchema`) se genera sola. La configuración guardada se lee con `(await featureState(tenantId, 'crm')).config`.

Recuerda: ocultar en la interfaz es comodidad; la seguridad la pone el servidor.

## 9. Pruebas

Copia el patrón de `test/features.test.ts` (servidor de pruebas en `test/_server.ts`) y cubre al menos: rutas 403 con el módulo inactivo, que una empresa no ve los datos de otra, el permiso de cada acción y que los datos siguen ahí al reactivar.
