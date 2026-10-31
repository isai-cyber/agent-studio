// Rutas de las webs de las empresas.
//
// /api/web/*                  la empresa edita su web, catálogo, pedidos y cobros (módulo web_store)
// /api/platform/site-templates el superadmin sube las plantillas
// /s/<empresa>                la web pública (también en el dominio propio de la empresa)
// /s/<empresa>/checkout       el comprador paga (Stripe Connect o Mercado Pago marketplace)
// /oauth/mercadopago/callback, /webhooks/stripe, /webhooks/mercadopago  vuelta y avisos de los proveedores
// /tls-allowed?domain=        para el TLS bajo demanda de Caddy: solo dominios de webs publicadas
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { route, send, json, readBody, query, ipOf } from '../http.ts';
import type { Ctx } from '../authz/context.ts';
import { audit } from '../tenancy/audit.ts';
import { dbEnabled } from '../db/pool.ts';
import { ROOT } from '../store.ts';
import { tenantDataPath } from '../tenancy/paths.ts';
import { getTenant, getTenantBySlug, type Tenant } from '../tenancy/tenants.ts';
import { siteTenantByDomain } from '../tenancy/platform.ts';
import { usableFeatures } from '../features/state.ts';
import { getPlatformSettings } from '../platform-settings.ts';
import { renderSite, undeclaredFields, esc } from './render.ts';
import { listTemplates, getTemplate, saveTemplate, getSite, saveSite, listProducts, saveProduct, deleteProduct, listOrders } from './store.ts';
import {
  accountStatus, marketplaceStatus, stripeOnboardingLink, refreshStripeAccount, mercadopagoAuthUrl, mercadopagoCallback, mpRedirectUri,
  disconnectAccount, shopProvider, checkout, confirmOrder, mercadopagoPayment, verifyStripeSignature, type Provider,
} from './payments.ts';

const actor = (ctx: Ctx) => ({ actor: ctx.actor, ip: ctx.ip });
const proto = (req: IncomingMessage) => (req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === 'true' ? 'https' : 'http');
const baseUrl = (req: IncomingMessage) => `${proto(req)}://${req.headers.host ?? 'localhost'}`;
// Dirección pública de la plataforma (para enlaces que salen de una web con dominio propio)
const platformUrl = (req: IncomingMessage) => (process.env.PUBLIC_HOST ? `${proto(req)}://${process.env.PUBLIC_HOST}` : baseUrl(req));

const IMAGE_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const MEDIA_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// Productos de ejemplo para la vista previa de una plantilla
const SAMPLE = [
  { id: 1, name: 'Producto de ejemplo', description: 'Descripción breve del producto.', price: 199, image_url: null, stock: null },
  { id: 2, name: 'Otro producto', description: 'Así se verá tu catálogo.', price: 349.5, image_url: null, stock: 0 },
];

const templateSummary = (t: Awaited<ReturnType<typeof getTemplate>>) => ({ id: t.id, name: t.name, description: t.description, fields: t.fields });

export function registerSiteRoutes(): void {
  // ---------- la empresa ----------
  route('GET', '/api/web', { feature: 'web_store', perm: 'web_store.site.read' }, async (req, res, _p, ctx) => {
    const site = await getSite(ctx.tenantId);
    const template = site.templateId ? await getTemplate(site.templateId).catch(() => null) : null;
    send(res, 200, {
      site,
      templates: (await listTemplates(true)).map(templateSummary),
      template: template ? templateSummary(template) : null,
      url: `${platformUrl(req)}/s/${ctx.tenant.slug}`,
      domainTarget: process.env.PUBLIC_HOST ?? null, // a dónde debe apuntar el CNAME del dominio propio
      provider: await shopProvider(ctx.tenantId),
    });
  });

  route('PUT', '/api/web', { feature: 'web_store', perm: 'web_store.site.write' }, async (req, res, _p, ctx) => {
    const body = await json<Parameters<typeof saveSite>[1]>(req);
    const before = await getSite(ctx.tenantId);
    const site = await saveSite(ctx.tenantId, body);
    const changed = (['templateId', 'published', 'customDomain', 'currency', 'paymentProvider'] as const).filter((k) => before[k] !== site[k]);
    if (changed.length || body.content !== undefined) {
      await audit({ tenantId: ctx.tenantId, ...actor(ctx), action: 'site.updated', target: 'site', before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: { ...Object.fromEntries(changed.map((k) => [k, site[k]])), ...(body.content !== undefined ? { content: Object.keys(site.content) } : {}) } });
    }
    send(res, 200, site);
  });

  // Vista previa: con el contenido que se envía (sin guardar) o con el guardado
  route('POST', '/api/web/preview', { feature: 'web_store', perm: 'web_store.site.read' }, async (req, res, _p, ctx) => {
    const body = await json<{ templateId?: number; content?: Record<string, unknown> }>(req);
    const site = await getSite(ctx.tenantId);
    const id = Number(body.templateId ?? site.templateId);
    if (!id) return send(res, 400, { error: 'Elige una plantilla' });
    const t = await getTemplate(id);
    if (!t.active) return send(res, 400, { error: 'Esa plantilla no está disponible' });
    const html = renderSite({
      html: t.html, fields: t.fields, content: body.content ?? site.content, tenantName: ctx.tenant.name,
      products: await listProducts(ctx.tenantId, true), currency: site.currency, language: ctx.tenant.language, shopBase: '', canBuy: false,
    });
    send(res, 200, html, 'text/html; charset=utf-8');
  });

  // Imágenes de la web y del catálogo (se sirven en /s-media/<empresa>/<archivo>)
  route('POST', '/api/web/upload', { feature: 'web_store', anyPerm: ['web_store.site.write', 'web_store.products.write'] }, async (req, res, _p, ctx) => {
    const ext = IMAGE_TYPES[String(req.headers['content-type'] ?? '').split(';')[0].trim()];
    if (!ext) return send(res, 400, { error: 'Sube una imagen PNG, JPG, WebP o GIF' });
    const data = await readBody(req, 5 * 1024 * 1024);
    if (!data.length) return send(res, 400, { error: 'La imagen está vacía' });
    const name = `${randomUUID()}${ext}`;
    await mkdir(tenantDataPath(ctx.tenantId, 'site'), { recursive: true });
    await writeFile(tenantDataPath(ctx.tenantId, 'site', name), data);
    send(res, 201, { url: `/s-media/${ctx.tenantId}/${name}` });
  });

  route('GET', '/api/web/products', { feature: 'web_store', perm: 'web_store.products.read' }, async (_req, res, _p, ctx) => send(res, 200, await listProducts(ctx.tenantId)));
  route('POST', '/api/web/products', { feature: 'web_store', perm: 'web_store.products.write' }, async (req, res, _p, ctx) => {
    const p = await saveProduct(ctx.tenantId, { ...(await json<Record<string, unknown>>(req)), id: undefined });
    await audit({ tenantId: ctx.tenantId, ...actor(ctx), action: 'product.created', target: `product:${p.id}`, after: { name: p.name, price: p.price } });
    send(res, 201, p);
  });
  route('PUT', '/api/web/products/:id', { feature: 'web_store', perm: 'web_store.products.write' }, async (req, res, [id], ctx) => {
    const p = await saveProduct(ctx.tenantId, { ...(await json<Record<string, unknown>>(req)), id: Number(id) });
    await audit({ tenantId: ctx.tenantId, ...actor(ctx), action: 'product.updated', target: `product:${p.id}`, after: { name: p.name, price: p.price, active: p.active } });
    send(res, 200, p);
  });
  route('DELETE', '/api/web/products/:id', { feature: 'web_store', perm: 'web_store.products.write' }, async (_req, res, [id], ctx) => {
    await deleteProduct(ctx.tenantId, Number(id));
    await audit({ tenantId: ctx.tenantId, ...actor(ctx), action: 'product.deleted', target: `product:${id}` });
    send(res, 204, '');
  });

  route('GET', '/api/web/orders', { feature: 'web_store', perm: 'web_store.orders.read' }, async (_req, res, _p, ctx) => send(res, 200, await listOrders(ctx.tenantId)));

  // Cobros: la empresa conecta SU cuenta pulsando «Conectar» (sin pegar claves)
  route('GET', '/api/web/payments', { feature: 'web_store', perm: 'web_store.payments.manage' }, async (_req, res, _p, ctx) => {
    send(res, 200, { accounts: await accountStatus(ctx.tenantId), platform: marketplaceStatus() });
  });
  route('POST', '/api/web/payments/stripe/connect', { feature: 'web_store', perm: 'web_store.payments.manage' }, async (req, res, _p, ctx) => {
    const url = await stripeOnboardingLink(ctx.tenantId, platformUrl(req));
    await audit({ tenantId: ctx.tenantId, ...actor(ctx), action: 'payments.connect_started', target: 'payments:stripe' });
    send(res, 200, { url });
  });
  route('POST', '/api/web/payments/stripe/refresh', { feature: 'web_store', perm: 'web_store.payments.manage' }, async (_req, res, _p, ctx) => {
    await refreshStripeAccount(ctx.tenantId);
    send(res, 200, { accounts: await accountStatus(ctx.tenantId), platform: marketplaceStatus() });
  });
  route('POST', '/api/web/payments/mercadopago/connect', { feature: 'web_store', perm: 'web_store.payments.manage' }, async (req, res, _p, ctx) => {
    send(res, 200, { url: mercadopagoAuthUrl(ctx.tenantId, platformUrl(req)) });
  });
  route('DELETE', '/api/web/payments/:provider', { feature: 'web_store', perm: 'web_store.payments.manage' }, async (_req, res, [provider], ctx) => {
    if (provider !== 'stripe' && provider !== 'mercadopago') return send(res, 404, { error: 'Proveedor no válido' });
    await disconnectAccount(ctx.tenantId, provider);
    await audit({ tenantId: ctx.tenantId, ...actor(ctx), action: 'payments.disconnected', target: `payments:${provider}` });
    send(res, 204, '');
  });

  // ---------- superadmin: plantillas ----------
  route('GET', '/api/platform/site-templates', { platform: true }, async (_req, res) => {
    send(res, 200, (await listTemplates()).map((t) => ({ ...t, undeclared: undeclaredFields(t.html, t.fields) })));
  });
  route('POST', '/api/platform/site-templates', { platform: true }, async (req, res, _p, ctx) => {
    const t = await saveTemplate({ ...(await json<Record<string, unknown>>(req)), id: undefined });
    await audit({ tenantId: null, ...actor(ctx), action: 'site_template.created', target: `site_template:${t.id}`, after: { name: t.name, fields: t.fields.map((f) => f.key) } });
    send(res, 201, { ...t, undeclared: undeclaredFields(t.html, t.fields) });
  });
  route('PUT', '/api/platform/site-templates/:id', { platform: true }, async (req, res, [id], ctx) => {
    const t = await saveTemplate({ ...(await json<Record<string, unknown>>(req)), id: Number(id) });
    await audit({ tenantId: null, ...actor(ctx), action: 'site_template.updated', target: `site_template:${t.id}`, after: { name: t.name, active: t.active, fields: t.fields.map((f) => f.key) } });
    send(res, 200, { ...t, undeclared: undeclaredFields(t.html, t.fields) });
  });
  // Importa los ejemplos de site-templates/ que aún no existan (por nombre)
  route('POST', '/api/platform/site-templates/examples', { platform: true }, async (_req, res, _p, ctx) => {
    const have = new Set((await listTemplates()).map((t) => t.name));
    const dir = join(ROOT, 'site-templates');
    const added: string[] = [];
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
      const meta = JSON.parse(await readFile(join(dir, f), 'utf8'));
      if (have.has(meta.name)) continue;
      const t = await saveTemplate({ ...meta, html: await readFile(join(dir, f.replace(/\.json$/, '.html')), 'utf8') });
      added.push(t.name);
      await audit({ tenantId: null, ...actor(ctx), action: 'site_template.created', target: `site_template:${t.id}`, after: { name: t.name, example: true } });
    }
    send(res, 200, { added });
  });
  route('GET', '/api/platform/site-templates/:id/preview', { platform: true }, async (_req, res, [id]) => {
    const t = await getTemplate(Number(id));
    send(res, 200, renderSite({ html: t.html, fields: t.fields, content: {}, tenantName: 'Tu empresa', products: SAMPLE, currency: 'MXN', language: 'es', shopBase: '', canBuy: true }), 'text/html; charset=utf-8');
  });
  // Lo que hay que registrar en Stripe / Mercado Pago para el marketplace
  route('GET', '/api/platform/marketplace', { platform: true }, async (req, res) => {
    send(res, 200, { ...marketplaceStatus(), mpRedirectUri: mpRedirectUri(platformUrl(req)), stripeWebhookUrl: `${platformUrl(req)}/webhooks/stripe`, stripeWebhookSigned: Boolean(getPlatformSettings().billing.stripe?.webhookSecret) });
  });
}

// ---------- parte pública ----------

// Dominios propios: caché corta para no consultar la base en cada petición
const domainCache = new Map<string, { tenantId: number | null; at: number }>();
async function tenantForHost(host: string): Promise<number | null> {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (!dbEnabled || !h || h === 'localhost' || /^[\d.]+$/.test(h) || h === process.env.PUBLIC_HOST?.toLowerCase()) return null;
  const hit = domainCache.get(h);
  if (hit && Date.now() - hit.at < 30_000) return hit.tenantId;
  const tenantId = await siteTenantByDomain(h);
  domainCache.set(h, { tenantId, at: Date.now() });
  return tenantId;
}
export const clearDomainCache = () => domainCache.clear();

// Una web solo se ve si la empresa está activa, tiene el módulo y la ha publicado
async function liveSite(tenant: Tenant | null) {
  if (!tenant || tenant.status !== 'active') return null;
  if (!(await usableFeatures(tenant.id)).has('web_store')) return null;
  const site = await getSite(tenant.id);
  if (!site.published || !site.templateId) return null;
  const template = await getTemplate(site.templateId).catch(() => null);
  return template ? { tenant, site, template } : null;
}

const page = (title: string, body: string, lang = 'es') =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 16px;color:#222;line-height:1.5}a{color:#2563eb}</style></head><body>${body}</body></html>`;

const notFound = (res: ServerResponse) => send(res, 404, page('No encontrada', '<h1>Esta web no está disponible</h1>'), 'text/html; charset=utf-8');

// Atiende las rutas públicas de las webs. Devuelve false si la petición no es suya.
export async function handleSites(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path === '/tls-allowed') {
    const d = String(query(req).get('domain') ?? '').toLowerCase();
    const ok = dbEnabled && d && (d === process.env.PUBLIC_HOST?.toLowerCase() || (await siteTenantByDomain(d)) !== null);
    send(res, ok ? 200 : 404, ok ? 'ok' : 'no', 'text/plain');
    return true;
  }
  if (path.startsWith('/s-media/')) {
    const m = path.match(/^\/s-media\/([1-9]\d*)\/([0-9a-f-]{36}\.(png|jpg|webp|gif))$/);
    const file = m ? tenantDataPath(Number(m[1]), 'site', m[2]) : '';
    if (!m || !existsSync(file)) { send(res, 404, 'No encontrado', 'text/plain'); return true; }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    send(res, 200, await readFile(file), MEDIA_MIME[`.${m[3]}`]);
    return true;
  }
  if (path === '/oauth/mercadopago/callback') {
    const q = query(req);
    try {
      if (q.get('error')) throw Object.assign(new Error('Cancelaste la autorización en Mercado Pago.'), { status: 400 });
      const tenantId = await mercadopagoCallback(String(q.get('state') ?? ''), String(q.get('code') ?? ''), platformUrl(req));
      await audit({ tenantId, actor: { type: 'system' }, ip: ipOf(req), action: 'payments.connected', target: 'payments:mercadopago' });
      res.writeHead(302, { Location: '/?web=pagos' });
      res.end();
    } catch (err) {
      send(res, (err as { status?: number }).status ?? 500, page('Mercado Pago', `<h1>No se pudo conectar Mercado Pago</h1><p>${esc((err as Error).message)}</p><p><a href="/?web=pagos">Volver</a></p>`), 'text/html; charset=utf-8');
    }
    return true;
  }
  // El enlace de alta de Stripe caducó: la interfaz pide uno nuevo
  if (path === '/oauth/stripe/refresh') {
    res.writeHead(302, { Location: '/?web=pagos&stripe=reintentar' });
    res.end();
    return true;
  }
  if (path === '/webhooks/stripe' && req.method === 'POST') {
    await stripeWebhook(req, res);
    return true;
  }
  if (path === '/webhooks/mercadopago' && req.method === 'POST') {
    await mercadopagoWebhook(req, res);
    return true;
  }

  // La web: /s/<empresa>/... o, en un dominio propio, la raíz
  let tenant: Tenant | null = null;
  let rest: string;
  let shopUrl: string;
  const m = path.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    tenant = await getTenantBySlug(m[1]);
    rest = m[2] ?? '/';
    shopUrl = `${baseUrl(req)}/s/${m[1]}`;
  } else {
    const tenantId = await tenantForHost(String(req.headers.host ?? ''));
    if (tenantId === null) return false;
    // En un dominio propio solo existe la web (el script del carrito y las imágenes se sirven arriba / desde public)
    if (path === '/site-shop.js') return false;
    tenant = await getTenant(tenantId);
    rest = path;
    shopUrl = `${proto(req)}://${req.headers.host}`;
  }
  const live = await liveSite(tenant);
  if (!live) { notFound(res); return true; }
  const lang = live.tenant.language;

  if (rest === '/' && req.method === 'GET') {
    const canBuy = (await shopProvider(live.tenant.id)) !== null;
    const html = renderSite({
      html: live.template.html, fields: live.template.fields, content: live.site.content, tenantName: live.tenant.name,
      products: await listProducts(live.tenant.id, true), currency: live.site.currency, language: lang, shopBase: shopUrl, canBuy,
    });
    send(res, 200, html, 'text/html; charset=utf-8');
    return true;
  }
  if (rest === '/checkout' && req.method === 'POST') {
    const r = await checkout(live.tenant.id, await json(req), shopUrl);
    send(res, 200, r);
    return true;
  }
  if (rest === '/gracias' && req.method === 'GET') {
    const q = query(req);
    const ref = String(q.get('pedido') ?? '');
    const order = /^[0-9a-f]{24}$/.test(ref)
      ? await confirmOrder(live.tenant.id, ref, { sessionId: q.get('session_id') ?? undefined, paymentId: q.get('payment_id') ?? q.get('collection_id') ?? undefined }).catch(() => null)
      : null;
    const en = lang === 'en';
    const msg = !order ? (en ? 'Order not found.' : 'No encontramos el pedido.')
      : order.status === 'paid' ? (en ? `Payment received. Your order number is <b>${esc(order.reference.slice(-8).toUpperCase())}</b>.` : `Pago recibido. Tu número de pedido es <b>${esc(order.reference.slice(-8).toUpperCase())}</b>.`)
        : (en ? 'We are confirming your payment. You will receive an email when it is approved.' : 'Estamos confirmando tu pago. Recibirás un email cuando se apruebe.');
    send(res, 200, page(live.tenant.name, `<h1>${en ? 'Thank you!' : '¡Gracias!'}</h1><p>${msg}</p><p><a href="${esc(shopUrl)}">${en ? 'Back to the store' : 'Volver a la tienda'}</a></p><script>try{localStorage.removeItem('as-cart:${esc(shopUrl)}')}catch{}</script>`, lang), 'text/html; charset=utf-8');
    return true;
  }
  notFound(res);
  return true;
}

// Avisos de Stripe. Aunque no haya secreto de firma configurado, el pedido solo se
// marca pagado tras consultar la sesión a Stripe (confirmOrder), nunca por el aviso.
async function stripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
  const secret = getPlatformSettings().billing.stripe?.webhookSecret;
  if (secret && !verifyStripeSignature(raw, String(req.headers['stripe-signature'] ?? ''), secret)) return send(res, 400, { error: 'Firma no válida' });
  let ev: any;
  try { ev = JSON.parse(raw); } catch { return send(res, 400, { error: 'JSON inválido' }); }
  const obj = ev?.data?.object ?? {};
  const tenantId = Number(obj.metadata?.tenant_id);
  try {
    if (tenantId && (await getTenant(tenantId))) {
      if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') await confirmOrder(tenantId, String(obj.metadata?.order ?? ''), { sessionId: obj.id });
      else if (ev.type === 'account.updated') await refreshStripeAccount(tenantId);
    }
  } catch (err) {
    console.error('[webhooks/stripe]', (err as Error).message);
    return send(res, 500, { error: 'No se pudo procesar' }); // Stripe lo reintentará
  }
  send(res, 200, { received: true });
}

// Avisos de Mercado Pago (?tenant=<id>): se consulta el pago con el token del vendedor
async function mercadopagoWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = query(req);
  const raw = (await readBody(req, 256 * 1024)).toString('utf8');
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  const tenantId = Number(q.get('tenant'));
  const type = body.type ?? body.topic ?? q.get('type') ?? q.get('topic');
  const paymentId = String(body.data?.id ?? q.get('data.id') ?? q.get('id') ?? '');
  try {
    if (tenantId && type === 'payment' && /^\d+$/.test(paymentId) && (await getTenant(tenantId))) {
      const p = await mercadopagoPayment(tenantId, paymentId);
      if (p.external_reference) await confirmOrder(tenantId, String(p.external_reference), { paymentId });
    }
  } catch (err) {
    console.error('[webhooks/mercadopago]', (err as Error).message);
    return send(res, 500, { error: 'No se pudo procesar' });
  }
  send(res, 200, { received: true });
}

export type { Provider };
