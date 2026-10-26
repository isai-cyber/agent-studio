# Plan: multi-tenant, roles y permisos, y módulos activables

Este documento es el plan previo a programar (entregable 1). Recoge lo que se
encontró al explorar el código, las diferencias con el contexto del encargo y
los archivos que se tocan en cada fase.

## 1. Cómo funciona hoy (confirmado en el código)

| Pieza | Dónde | Notas |
|---|---|---|
| Servidor | `src/server.ts` | `node:http` sin framework. Tabla de rutas propia (`route()`), CSRF por `Origin`. |
| Usuarios | `src/auth.ts` | MariaDB solo si hay `DB_HOST`. Tablas `users` (`role` admin/user) y `sessions` (hash SHA-256 del token). Se crean con `CREATE TABLE IF NOT EXISTS` al arrancar; no hay migraciones versionadas. |
| Sin base de datos | `src/auth.ts` | Sin `DB_HOST` la app funciona **sin login**. Hay que conservar este modo. |
| Agentes | `src/store.ts` | `agents/<id>/agent.yaml` + `knowledge/`. Hay 13 agentes de ejemplo versionados en git. |
| Conexiones | `src/connections.ts` | `data/connections.json` en texto plano (0600). Además lee `FLOW_<APP>_<CAMPO>` del `.env`. |
| Métricas | `src/metrics.ts` | `data/metrics/events.jsonl` y `demo.jsonl`. |
| Flujos | `src/flows.ts` | `data/flows/<id>.json`, `data/flows/runs/<id>.jsonl` y `data/flows/state.json` (estado del programador). Audio TTS en `data/files/`. |
| Clave de API | `src/apikey.ts` | `data/api-key` o `AGENT_STUDIO_API_KEY`. Una sola clave con acceso total. |
| API pública | `src/public-api.ts`, `src/mcp.ts` | `/v1/*`, `/v1/chat/completions`, `/mcp` (HTTP) y `npm run mcp` (stdio, sin clave). |
| Webhooks | `src/server.ts` (`handleHook`) | `/hooks/<id>` con `?token=` o `X-Flow-Token` opcional. |
| Módulos de automatización | `src/modules/registry.ts`, `modules/`, `modules-community/` | Se llaman "módulos" pero son **apps de flujos**. No confundir con los nuevos módulos de negocio (los llamaremos *features* en el código). |
| NanoClaw | `src/nanoclaw.ts` | La carpeta la decide NanoClaw a partir del **nombre** que se le envía (`folderFor`). |

## 2. Diferencias con el contexto del encargo

1. **Claves de las apps.** En `modules/apps/index.ts` las claves usan guion y
   algunos nombres no coinciden: `whatsapp` (no `whatsapp_business`) y
   `google-calendar` (no `google_calendar`). El registro de features usa las
   claves reales. `twilio`, `shopify`, `woocommerce`, `mercadopago` y `stripe`
   existen tal cual.
2. **`facturama` no existe.** Se añade un conector declarativo mínimo en
   `modules/apps/index.ts` para que `cfdi` pueda exigir esa conexión.
3. **Conexiones alternativas.** "shopify o woocommerce" no cabe en una lista
   plana: `requiredConnections` admite grupos (`[["shopify", "woocommerce"]]`
   = al menos una).
4. **Las claves de módulo de flujos no admiten puntos** (`^[a-z0-9][a-z0-9-]*$`).
   `flowModules: ["crm.*"]` se interpreta como `<módulo>.<acción|*>`.
5. **Variables del `.env` en agentes y flujos.** Hoy un agente puede leer
   cualquier variable del servidor con `{{env.X}}` en sus acciones (incluida
   `DEEPSEEK_API_KEY`) y los flujos ven todas las `FLOW_*`. Con varias empresas
   eso es una fuga entre empresas: se limita a variables `FLOW_*` y solo para la
   empresa Default. Lo mismo para las credenciales `FLOW_<APP>_<CAMPO>`.
6. **Archivos que no menciona el encargo:** `data/flows/state.json`,
   `data/metrics/demo.jsonl` y `data/files/*.mp3` también pasan a la carpeta de
   la empresa. `/files/<uuid>.mp3` pasa a `/files/<tenant_id>/<uuid>.mp3`.
7. **Registro abierto.** Antes, con `AUTH_ALLOW_SIGNUP=true`, cualquier cuenta
   nueva veía todo. Ahora una cuenta nueva sin invitación no pertenece a ninguna
   empresa (salvo que se active `TENANT_SELF_SIGNUP=true`, que le crea la suya).
8. **Permisos adicionales** que hacen falta y no estaban en la lista:
   `agents.read` (ver y chatear con agentes), `flows.read` (ver flujos y
   ejecuciones), `tenant.billing.manage` y `tenant.delete` (exclusivos del
   Propietario).

## 3. Decisiones de diseño

- **Empresa Default con id fijo `1`** (slug `default`). Así los agentes de
  ejemplo del repo pueden vivir en `agents/1/` y la ruta vieja de webhooks se
  resuelve sin consultar nada.
- **El `tenant_id` viaja explícito** (parámetro en `store`, `flows`,
  `connections`, `metrics`) y va pegado a los objetos en memoria
  (`agent.tenantId`, `flow.tenantId`), nunca se guarda en el YAML/JSON.
- **Un único punto de decisión** `can(ctx, { feature?, permission? })` que
  aplica el orden: empresa activa → plan → activado → dependencias →
  conexiones → permiso.
- **Roles del sistema calculados en código** a partir del catálogo de permisos,
  para que los permisos de módulos futuros les lleguen sin migrar. En la base
  solo se guardan las filas de rol (`is_system=1`, `system_key`) y los permisos
  de los roles propios.
- **Consultas con `tenant_id` obligatorio**: `tenantDb(id).query()` exige el
  marcador `:tenant` en el SQL y lo sustituye por el id. Una prueba estática
  falla si alguna consulta a tablas de empresa se hace por fuera.
- **Sin MariaDB** la app sigue funcionando sin login, como empresa Default con
  todos los permisos; los módulos de negocio quedan en solo lectura (se gestionan
  con base de datos).
- **Auditoría inmutable**: no hay rutas de escritura ni borrado y, si el usuario
  de la base tiene permiso, triggers que impiden `UPDATE`/`DELETE` en
  `audit_log`.
- **Eliminar empresa = baja lógica** (`status = 'deleted'`): nunca se borran
  datos.

## 4. Archivos por fase

### Fase 1 · Modelo de datos y migración
- `src/root.ts` (nuevo): raíz del proyecto sin dependencias.
- `src/db/pool.ts` (nuevo): pool de MariaDB compartido (sale de `auth.ts`).
- `src/db/migrations.ts` (nuevo): migraciones versionadas e idempotentes
  (`schema_migrations`).
- `src/db/tenant-db.ts` (nuevo): helper que exige `tenant_id`.
- `src/tenancy/paths.ts` (nuevo): resolución central de rutas + anti *path traversal*.
- `src/tenancy/crypto.ts` (nuevo): AES-256-GCM con clave derivada por empresa.
- `src/tenancy/migrate.ts` + `scripts/migrate-tenancy.ts` (nuevos): `npm run migrate:tenancy`.
- `src/auth.ts`: usa el pool y las migraciones.
- `package.json`: scripts `migrate:tenancy` y `test`.

### Fase 2 · Aislamiento
- `src/store.ts`, `src/knowledge.ts`, `src/connections.ts`, `src/metrics.ts`,
  `src/flows.ts`, `src/apikey.ts`, `src/engine.ts`, `src/nanoclaw.ts`,
  `src/importer.ts`, `src/assistant.ts`, `src/actions.ts`, `src/modules/sdk.ts`,
  `scripts/build-dataset-agents.ts`: todo recibe el `tenantId`.
- `agents/<id>/` → `agents/1/<id>/` (git mv de los ejemplos).
- `src/server.ts`: `/hooks/<slug>/<id>` y ruta vieja obsoleta; `/files/<tenant>/…`.

### Fase 3 · Roles y permisos
- `src/authz/permissions.ts`, `src/authz/context.ts`, `src/authz/can.ts` (nuevos).
- `src/tenancy/tenants.ts`, `src/tenancy/users.ts`, `src/tenancy/roles.ts`,
  `src/tenancy/apikeys.ts`, `src/tenancy/audit.ts` (nuevos).
- `src/auth.ts`: empresa activa en la sesión, invitaciones, auditoría de login.
- `src/server.ts`: cada ruta declara su permiso; rutas de administración.
- `src/public-api.ts`, `src/mcp.ts`, `src/mcp-stdio.ts`: clave por empresa con *scopes*.

### Fase 4 · Registro de módulos y su aplicación
- `src/features/registry.ts`, `src/features/state.ts`,
  `src/features/schema.ts`, `src/features/hooks.ts` (nuevos).
- `src/engine.ts` (herramientas del agente), `src/flows.ts` (pasos y
  programador en pausa), `src/server.ts` (webhooks 403, `/api/modules` filtrado).
- `modules/apps/index.ts`: conector `facturama`.

### Fase 5 · Interfaz
- `public/index.html`, `public/app.js`, `public/auth.js`, `public/flows.js`,
  `public/style.css`.
- `public/settings.js` (nuevo): Módulos, Usuarios, Roles, Claves de API, Auditoría.
- `public/admin.js` (nuevo): Superadmin → Empresas y planes.

### Fase 6 · Pruebas y documentación
- `test/*.test.ts` (nuevos, `node --test`).
- `README.md`, `FEATURES.md` (nuevo), `.env.example`.
