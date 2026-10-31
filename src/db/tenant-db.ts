// Acceso a tablas de negocio con el tenant_id obligatorio.
//
// Ninguna consulta a una tabla de empresa puede ejecutarse sin él: el SQL debe
// llevar el marcador `:tenant` (en el WHERE, o en el VALUES de un INSERT) y aquí
// se sustituye por el id de la empresa como parámetro. Si falta, la consulta se
// rechaza antes de llegar a la base.
//
//   const t = tenantDb(ctx.tenantId);
//   await t.query('SELECT * FROM api_keys WHERE tenant_id = :tenant AND id = ?', [id]);
//   await t.query('INSERT INTO api_keys (tenant_id, name) VALUES (:tenant, ?)', [name]);
//
// test/tenant-db.test.ts comprueba además, leyendo el código, que nadie consulta
// estas tablas con db().query() por fuera de los archivos permitidos.
import type { Pool, PoolConnection } from 'mariadb';
import { db } from './pool.ts';

// Tablas con datos de una empresa. Toda tabla de negocio nueva debe añadirse
// aquí y llevar `tenant_id ... NOT NULL` con índice.
export const TENANT_TABLES = ['tenant_features', 'memberships', 'invitations', 'api_keys', 'audit_log', 'roles', 'role_permissions', 'billing_charges'] as const;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export function assertTenantId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw fail(400, 'Falta la empresa (tenant_id) o no es válida');
  return id;
}

// Convierte `:tenant` en `?` respetando el orden de los parámetros
export function bindTenant(tenantId: number, sql: string, params: unknown[] = []): { sql: string; params: unknown[] } {
  assertTenantId(tenantId);
  if (!/:tenant\b/.test(sql)) throw fail(500, `Consulta sin tenant_id: ${sql.slice(0, 80)}`);
  if (!/\btenant_id\b/.test(sql)) throw fail(500, `La consulta usa :tenant pero no filtra por tenant_id: ${sql.slice(0, 80)}`);
  const out: unknown[] = [];
  let i = 0;
  const bound = sql.replace(/\?|:tenant\b/g, (tok) => {
    if (tok === '?') {
      if (i >= params.length) throw fail(500, 'Faltan parámetros en la consulta');
      out.push(params[i++]);
    } else out.push(tenantId);
    return '?';
  });
  if (i !== params.length) throw fail(500, 'Sobran parámetros en la consulta');
  return { sql: bound, params: out };
}

export interface TenantDb {
  readonly tenantId: number;
  query<T = any>(sql: string, params?: unknown[]): Promise<T>;
}

export function tenantDb(tenantId: number, conn?: PoolConnection | Pool): TenantDb {
  assertTenantId(tenantId);
  return {
    tenantId,
    async query(sql, params = []) {
      const b = bindTenant(tenantId, sql, params);
      return (conn ?? db()).query(b.sql, b.params);
    },
  };
}
