// Registro de auditoría (no desactivable). Solo se añade: no hay funciones para
// editar ni borrar entradas, y la base lo impide con triggers (migración 4).
// Nunca se guardan secretos: de las conexiones solo se apuntan los nombres de campo.
import { dbEnabled, parseJson } from '../db/pool.ts';
import { tenantDb } from '../db/tenant-db.ts';
import { insertPlatformAudit } from './platform.ts';

export type ActorType = 'user' | 'api_key' | 'system' | 'superadmin';

export interface AuditActor { type: ActorType; userId?: number | null; apiKeyId?: number | null }

export interface AuditEntry {
  tenantId: number | null; // null = acción de plataforma (p. ej. crear un plan)
  actor: AuditActor;
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export async function audit(e: AuditEntry): Promise<void> {
  if (!dbEnabled) return;
  // Una clave de API se identifica en el objetivo (no hay usuario)
  const target = e.target ?? (e.actor.apiKeyId ? `api_key:${e.actor.apiKeyId}` : null);
  const row = [e.actor.userId ?? null, e.actor.type, e.action.slice(0, 80), target?.slice(0, 190) ?? null, json(e.before), json(e.after), e.ip?.slice(0, 64) ?? null];
  try {
    if (e.tenantId === null) await insertPlatformAudit(row);
    else await tenantDb(e.tenantId).query('INSERT INTO audit_log (tenant_id, actor_user_id, actor_type, action, target, `before`, `after`, ip) VALUES (:tenant, ?, ?, ?, ?, ?, ?, ?)', row);
  } catch (err) {
    // La auditoría no debe tumbar la operación, pero sí dejar rastro
    console.error('[auditoría] no se pudo registrar', e.action, (err as Error).message);
  }
}

export interface AuditFilter { actor?: string; action?: string; from?: string; to?: string; limit?: number; offset?: number }

export interface AuditRow {
  id: number; tenantId: number | null; actorUserId: number | null; actorEmail: string | null; actorType: ActorType;
  action: string; target: string | null; before: unknown; after: unknown; ip: string | null; createdAt: string;
}

export async function listAudit(tenantId: number, f: AuditFilter = {}): Promise<{ rows: AuditRow[]; total: number }> {
  // Los comodines de LIKE se escapan: "agent.tool_blocked" no debe leer el _ como comodín
  const like = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
  const where = ['a.tenant_id = :tenant'];
  const params: unknown[] = [];
  if (f.action) { where.push('a.action LIKE ?'); params.push(`${like(f.action)}%`); }
  if (f.actor) {
    if (['user', 'api_key', 'system', 'superadmin'].includes(f.actor)) { where.push('a.actor_type = ?'); params.push(f.actor); }
    else { where.push('(u.email LIKE ? OR a.target LIKE ?)'); params.push(`%${like(f.actor)}%`, `%${like(f.actor)}%`); }
  }
  if (f.from && !Number.isNaN(Date.parse(f.from))) { where.push('a.created_at >= ?'); params.push(new Date(f.from)); }
  if (f.to && !Number.isNaN(Date.parse(f.to))) { where.push('a.created_at < ?'); params.push(new Date(Date.parse(f.to) + (f.to.length <= 10 ? 86_400_000 : 0))); }
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 5000);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const t = tenantDb(tenantId);
  const from = `FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${where.join(' AND ')}`;
  const [{ total }] = await t.query(`SELECT COUNT(*) AS total ${from}`, params);
  const rows = await t.query(`SELECT a.*, u.email AS actor_email ${from} ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  return {
    total,
    rows: rows.map((r: any) => ({
      id: r.id, tenantId: r.tenant_id, actorUserId: r.actor_user_id, actorEmail: r.actor_email ?? null, actorType: r.actor_type,
      action: r.action, target: r.target, before: parseJson(r.before, null), after: parseJson(r.after, null), ip: r.ip,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Evita la inyección de fórmulas al abrir el CSV en una hoja de cálculo
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function auditCsv(rows: AuditRow[]): string {
  const head = ['fecha', 'actor', 'tipo_actor', 'accion', 'objetivo', 'antes', 'despues', 'ip'];
  const lines = rows.map((r) => [r.createdAt, r.actorEmail ?? r.actorUserId ?? '', r.actorType, r.action, r.target, r.before, r.after, r.ip].map(csvCell).join(','));
  return `﻿${head.join(',')}\n${lines.join('\n')}\n`;
}
