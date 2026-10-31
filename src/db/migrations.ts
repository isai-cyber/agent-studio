// Migraciones de MariaDB versionadas e idempotentes. Cada una se aplica una sola
// vez (tabla schema_migrations) y además está escrita para poder repetirse sin
// romper nada (IF NOT EXISTS, INSERT IGNORE...), por si una se cortó a medias.
// Se ejecutan al arrancar el servidor y con `npm run migrate:tenancy`.
import type { PoolConnection } from 'mariadb';
import { db } from './pool.ts';
import { FEATURES } from '../features/registry.ts';
import { SYSTEM_ROLES } from '../authz/permissions.ts';

interface Migration { version: number; name: string; up: (c: PoolConnection) => Promise<void | string> }

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

// Planes iniciales (el superadmin los edita después). NULL = sin límite.
const PLANS = [
  { key: 'basico', name: 'Básico', conv: 1000, users: 3, agents: 3, campaign: 0, price: 0.05, features: ['crm', 'inbox', 'web_widget', 'evals'] },
  { key: 'pro', name: 'Pro', conv: 10000, users: 15, agents: 20, campaign: 5000, price: 0.03, features: ['crm', 'inbox', 'inventory', 'orders', 'campaigns', 'chat_catalog', 'scheduling', 'evals', 'web_widget', 'cfdi'] },
  { key: 'empresa', name: 'Empresa', conv: null, users: null, agents: null, campaign: null, price: 0.02, features: FEATURES.map((f) => f.key) },
];

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'usuarios y sesiones',
    async up(c) {
      await c.query(`CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(190) NOT NULL UNIQUE,
        name VARCHAR(80) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin','user') NOT NULL DEFAULT 'user',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP NULL
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        user_agent VARCHAR(255) NULL,
        INDEX (user_id), INDEX (expires_at),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ${TABLE}`);
    },
  },
  {
    version: 2,
    name: 'empresas, planes, módulos, roles, invitaciones, claves de API y auditoría',
    async up(c) {
      await c.query(`CREATE TABLE IF NOT EXISTS plans (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        plan_key VARCHAR(40) NOT NULL UNIQUE,
        name VARCHAR(80) NOT NULL,
        max_conversations_month INT UNSIGNED NULL,
        max_users INT UNSIGNED NULL,
        max_agents INT UNSIGNED NULL,
        max_campaign_messages INT UNSIGNED NULL,
        price_per_conversation DECIMAL(10,4) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS plan_features (
        plan_id INT UNSIGNED NOT NULL,
        feature_key VARCHAR(60) NOT NULL,
        PRIMARY KEY (plan_id, feature_key),
        FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS tenants (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        slug VARCHAR(60) NOT NULL UNIQUE,
        plan_id INT UNSIGNED NOT NULL,
        status ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
        country CHAR(2) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES plans(id)
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS tenant_features (
        tenant_id INT UNSIGNED NOT NULL,
        feature_key VARCHAR(60) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        config JSON NULL,
        updated_by INT UNSIGNED NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, feature_key),
        INDEX (tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS roles (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT UNSIGNED NULL,
        system_key VARCHAR(20) NULL UNIQUE,
        name VARCHAR(80) NOT NULL,
        description VARCHAR(255) NULL,
        is_system TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX (tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INT UNSIGNED NOT NULL,
        tenant_id INT UNSIGNED NOT NULL,
        permission VARCHAR(120) NOT NULL,
        PRIMARY KEY (role_id, permission),
        INDEX (tenant_id),
        FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS memberships (
        user_id INT UNSIGNED NOT NULL,
        tenant_id INT UNSIGNED NOT NULL,
        role_id INT UNSIGNED NOT NULL,
        status ENUM('active','disabled') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, tenant_id),
        INDEX (tenant_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (role_id) REFERENCES roles(id)
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS invitations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT UNSIGNED NOT NULL,
        email VARCHAR(190) NOT NULL,
        role_id INT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        invited_by INT UNSIGNED NULL,
        expires_at TIMESTAMP NOT NULL,
        accepted_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX (tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (role_id) REFERENCES roles(id)
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS api_keys (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT UNSIGNED NOT NULL,
        name VARCHAR(80) NOT NULL,
        key_hash CHAR(64) NOT NULL UNIQUE,
        prefix VARCHAR(16) NOT NULL,
        scopes JSON NOT NULL,
        created_by INT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP NULL,
        revoked_at TIMESTAMP NULL,
        INDEX (tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`);
      // Sin claves foráneas: la auditoría debe sobrevivir a todo lo demás
      await c.query(`CREATE TABLE IF NOT EXISTS audit_log (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT UNSIGNED NULL,
        actor_user_id INT UNSIGNED NULL,
        actor_type ENUM('user','api_key','system','superadmin') NOT NULL,
        action VARCHAR(80) NOT NULL,
        target VARCHAR(190) NULL,
        \`before\` JSON NULL,
        \`after\` JSON NULL,
        ip VARCHAR(64) NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX (tenant_id, created_at),
        INDEX (action),
        INDEX (actor_user_id)
      ) ${TABLE}`);
      await c.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin TINYINT(1) NOT NULL DEFAULT 0');
      await c.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_tenant_id INT UNSIGNED NULL');
    },
  },
  {
    version: 3,
    name: 'roles del sistema, planes iniciales y empresa Default',
    async up(c) {
      for (const r of SYSTEM_ROLES) {
        await c.query('INSERT IGNORE INTO roles (tenant_id, system_key, name, description, is_system) VALUES (NULL, ?, ?, ?, 1)', [r.key, r.name, r.description]);
      }
      for (const p of PLANS) {
        await c.query(
          'INSERT IGNORE INTO plans (plan_key, name, max_conversations_month, max_users, max_agents, max_campaign_messages, price_per_conversation) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [p.key, p.name, p.conv, p.users, p.agents, p.campaign, p.price],
        );
        const [{ id }] = await c.query('SELECT id FROM plans WHERE plan_key = ?', [p.key]);
        for (const f of p.features) await c.query('INSERT IGNORE INTO plan_features (plan_id, feature_key) VALUES (?, ?)', [id, f]);
      }
      // La empresa Default siempre es la 1 (agents/1/, /hooks/<id> sin empresa...)
      const [{ id: planId }] = await c.query("SELECT id FROM plans WHERE plan_key = 'empresa'");
      await c.query("INSERT IGNORE INTO tenants (id, name, slug, plan_id, status) VALUES (1, 'Default', 'default', ?, 'active')", [planId]);
    },
  },
  {
    version: 4,
    name: 'auditoría de solo lectura',
    // Triggers que impiden modificar o borrar la auditoría. Necesitan el permiso
    // TRIGGER (y, con binlog activo, log_bin_trust_function_creators): si no se
    // pueden crear, la auditoría sigue siendo de solo lectura desde la app.
    async up(c) {
      try {
        await c.query(`CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log es de solo lectura'`);
        await c.query(`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log es de solo lectura'`);
      } catch (err) {
        return `no se pudieron crear los triggers de solo lectura (${(err as Error).message}); la app no expone ninguna forma de modificar la auditoría`;
      }
    },
  },
  {
    version: 5,
    name: 'idioma y forma de cobro de cada empresa, y cobros de la plataforma',
    async up(c) {
      await c.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS language ENUM('es','en') NOT NULL DEFAULT 'es'");
      await c.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_provider ENUM('stripe','mercadopago') NULL");
      await c.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_email VARCHAR(190) NULL');
      // Cobros que la plataforma hace a cada empresa (enlace de pago de Stripe o Mercado Pago)
      await c.query(`CREATE TABLE IF NOT EXISTS billing_charges (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT UNSIGNED NOT NULL,
        provider ENUM('stripe','mercadopago') NOT NULL,
        description VARCHAR(190) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        external_id VARCHAR(190) NULL,
        url VARCHAR(1000) NULL,
        status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
        created_by INT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        paid_at TIMESTAMP NULL,
        INDEX (tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`);
    },
  },
  {
    version: 6,
    name: 'webs con plantillas, catálogo, pedidos y cuentas de cobro (marketplace)',
    async up(c) {
      // Plantillas que sube el superadmin (de la plataforma, sin empresa)
      await c.query(`CREATE TABLE IF NOT EXISTS site_templates (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        description VARCHAR(500) NULL,
        html MEDIUMTEXT NOT NULL,
        fields JSON NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ${TABLE}`);
      // La web de cada empresa (una por empresa): plantilla elegida y contenido editado
      await c.query(`CREATE TABLE IF NOT EXISTS sites (
        tenant_id INT UNSIGNED NOT NULL PRIMARY KEY,
        template_id INT UNSIGNED NULL,
        content JSON NOT NULL,
        published TINYINT(1) NOT NULL DEFAULT 0,
        custom_domain VARCHAR(190) NULL UNIQUE,
        currency CHAR(3) NOT NULL DEFAULT 'MXN',
        payment_provider ENUM('stripe','mercadopago') NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES site_templates(id) ON DELETE SET NULL
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS products (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT UNSIGNED NOT NULL,
        name VARCHAR(160) NOT NULL,
        description TEXT NULL,
        price DECIMAL(12,2) NOT NULL,
        image_url VARCHAR(500) NULL,
        stock INT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        sort INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX (tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`);
      await c.query(`CREATE TABLE IF NOT EXISTS shop_orders (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT UNSIGNED NOT NULL,
        reference CHAR(24) NOT NULL UNIQUE,
        provider ENUM('stripe','mercadopago') NOT NULL,
        status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
        customer_name VARCHAR(120) NULL,
        customer_email VARCHAR(190) NULL,
        items JSON NOT NULL,
        total DECIMAL(12,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        platform_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
        external_id VARCHAR(190) NULL,
        payment_id VARCHAR(190) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        paid_at TIMESTAMP NULL,
        INDEX (tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`);
      // Cuenta de cobro de cada empresa en el marketplace: cuenta conectada de Stripe o
      // autorización OAuth de Mercado Pago (tokens cifrados con la clave de la empresa)
      await c.query(`CREATE TABLE IF NOT EXISTS payment_accounts (
        tenant_id INT UNSIGNED NOT NULL,
        provider ENUM('stripe','mercadopago') NOT NULL,
        account_id VARCHAR(190) NOT NULL,
        secrets TEXT NULL,
        ready TINYINT(1) NOT NULL DEFAULT 0,
        expires_at TIMESTAMP NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, provider),
        INDEX (tenant_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`);
      // El módulo nuevo entra en los planes Pro y Empresa
      await c.query("INSERT IGNORE INTO plan_features (plan_id, feature_key) SELECT id, 'web_store' FROM plans WHERE plan_key IN ('pro', 'empresa')");
    },
  },
];

export interface MigrationReport { applied: { version: number; name: string; warning?: string }[]; current: number }

export async function runMigrations(log: (m: string) => void = () => {}): Promise<MigrationReport> {
  const conn = await db().getConnection();
  const report: MigrationReport = { applied: [], current: 0 };
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT UNSIGNED PRIMARY KEY,
      name VARCHAR(190) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ${TABLE}`);
    // Evita que dos procesos migren a la vez
    await conn.query("SELECT GET_LOCK('agent_studio_migrations', 30)");
    try {
      const done = new Set((await conn.query('SELECT version FROM schema_migrations')).map((r: { version: number }) => r.version));
      for (const m of MIGRATIONS) {
        if (done.has(m.version)) continue;
        // El DDL de MariaDB no es transaccional: cada sentencia es idempotente
        const warning = await m.up(conn);
        await conn.query('INSERT IGNORE INTO schema_migrations (version, name) VALUES (?, ?)', [m.version, m.name]);
        report.applied.push({ version: m.version, name: m.name, ...(warning ? { warning } : {}) });
        log(`✔ migración ${m.version}: ${m.name}${warning ? ` (⚠ ${warning})` : ''}`);
      }
      const [{ v }] = await conn.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
      report.current = Number(v);
    } finally {
      await conn.query("SELECT RELEASE_LOCK('agent_studio_migrations')");
    }
  } finally {
    conn.release();
  }
  return report;
}
