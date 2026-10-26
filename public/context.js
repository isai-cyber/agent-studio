// Contexto de la sesión en la interfaz: usuario, empresa activa, permisos y
// módulos (GET /api/me/context). Solo sirve para mostrar u ocultar cosas: la
// seguridad la valida siempre el servidor.
export let ctx = null;

export async function loadContext(api) {
  ctx = await api('/api/me/context');
  return ctx;
}

export const can = (perm) => Boolean(ctx?.local || ctx?.permissions?.includes(perm));
export const canAny = (...perms) => perms.some(can);
export const feature = (key) => ctx?.features?.find((f) => f.key === key);
export const featureOn = (key) => Boolean(feature(key)?.usable);
export const isPlatformAdmin = () => Boolean(ctx?.user?.isPlatformAdmin || ctx?.local);
