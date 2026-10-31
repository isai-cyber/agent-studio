// Caché corta de permisos y módulos por empresa. Se vacía al guardar cualquier
// cambio (roles, miembros, módulos, plan, conexiones) y, por si acaso, caduca
// sola a los PERMISSION_CACHE_TTL_MS (30 s por defecto).
const TTL = () => Number(process.env.PERMISSION_CACHE_TTL_MS ?? 30_000);

const store = new Map<string, { at: number; value: unknown }>();

export async function cachedFor<T>(tenantId: number, key: string, load: () => Promise<T>): Promise<T> {
  const k = `${tenantId}|${key}`;
  const hit = store.get(k);
  if (hit && Date.now() - hit.at < TTL()) return hit.value as T;
  const value = await load();
  store.set(k, { at: Date.now(), value });
  return value;
}

// Sin argumento: todas las empresas (p. ej. al editar un plan)
export function invalidatePermissions(tenantId?: number): void {
  if (tenantId === undefined) return store.clear();
  for (const k of store.keys()) if (k.startsWith(`${tenantId}|`)) store.delete(k);
}
