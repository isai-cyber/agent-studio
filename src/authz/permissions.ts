// Catálogo de permisos y roles del sistema.
//
// Formato: modulo.recurso.accion (p. ej. crm.contacts.write). Además de los
// permisos de cada módulo de negocio (src/features/registry.ts) hay permisos de
// plataforma para la propia app.
import { FEATURES } from '../features/registry.ts';

export interface PermissionInfo { key: string; label: string; group: string }

export const PLATFORM_PERMISSIONS: PermissionInfo[] = [
  { key: 'agents.read', label: 'Ver agentes y chatear con ellos', group: 'Agentes' },
  { key: 'agents.manage', label: 'Crear, editar, importar y eliminar agentes', group: 'Agentes' },
  { key: 'flows.read', label: 'Ver automatizaciones y sus ejecuciones', group: 'Automatizaciones' },
  { key: 'flows.manage', label: 'Crear, editar, ejecutar y eliminar automatizaciones', group: 'Automatizaciones' },
  { key: 'metrics.read', label: 'Ver métricas', group: 'Métricas' },
  { key: 'audit.read', label: 'Ver el registro de auditoría', group: 'Empresa' },
  { key: 'tenant.users.manage', label: 'Invitar, cambiar el rol y quitar usuarios', group: 'Empresa' },
  { key: 'tenant.roles.manage', label: 'Crear y editar roles', group: 'Empresa' },
  { key: 'tenant.features.manage', label: 'Activar, desactivar y configurar módulos', group: 'Empresa' },
  { key: 'tenant.connections.manage', label: 'Conectar apps y gestionar credenciales', group: 'Empresa' },
  { key: 'tenant.apikeys.manage', label: 'Crear y revocar claves de API', group: 'Empresa' },
  { key: 'tenant.billing.manage', label: 'Facturación y plan', group: 'Empresa' },
  { key: 'tenant.delete', label: 'Eliminar la empresa', group: 'Empresa' },
];

// Exclusivos del Propietario
export const OWNER_ONLY = ['tenant.billing.manage', 'tenant.delete'];

export function featurePermissions(): PermissionInfo[] {
  return FEATURES.flatMap((f) => f.permissions.map((key) => ({ key, label: key.split('.').slice(1).join(' · '), group: f.name })));
}

export function allPermissions(): string[] {
  return [...PLATFORM_PERMISSIONS.map((p) => p.key), ...featurePermissions().map((p) => p.key)];
}

export function isKnownPermission(p: string): boolean {
  return allPermissions().includes(p);
}

export type SystemRoleKey = 'owner' | 'admin' | 'operator' | 'viewer';

export const SYSTEM_ROLES: { key: SystemRoleKey; name: string; description: string }[] = [
  { key: 'owner', name: 'Propietario', description: 'Todos los permisos, incluida la facturación y eliminar la empresa.' },
  { key: 'admin', name: 'Admin', description: 'Todos los permisos salvo facturación y eliminar la empresa.' },
  { key: 'operator', name: 'Operador', description: 'Usa los módulos activos (bandeja, contactos, pedidos, citas). No cambia configuración, módulos ni usuarios.' },
  { key: 'viewer', name: 'Solo lectura', description: 'Únicamente los permisos de lectura (*.read).' },
];

// Se calculan en código para que los permisos de módulos nuevos les lleguen solos.
// Operador: lecturas + todos los permisos de uso de los módulos, salvo los de
// configuración (*.manage) y los destructivos (*.delete).
export function systemRolePermissions(key: SystemRoleKey): string[] {
  const all = allPermissions();
  switch (key) {
    case 'owner': return all;
    case 'admin': return all.filter((p) => !OWNER_ONLY.includes(p));
    case 'viewer': return all.filter((p) => p.endsWith('.read'));
    case 'operator': {
      const usage = featurePermissions().map((p) => p.key).filter((p) => !p.endsWith('.manage') && !p.endsWith('.delete'));
      return [...new Set([...all.filter((p) => p.endsWith('.read')), ...usage])];
    }
  }
}
