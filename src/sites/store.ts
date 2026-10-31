// Datos de las webs: plantillas (de la plataforma, las sube el superadmin), la web
// de cada empresa, su catálogo y sus pedidos. Todo lo de una empresa va con tenantDb().
import { db, parseJson } from '../db/pool.ts';
import { tenantDb } from '../db/tenant-db.ts';
import { validateFields, cleanValue, safeUrl, type TemplateField } from './render.ts';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// ---------- plantillas (superadmin) ----------

export interface SiteTemplate { id: number; name: string; description: string | null; html: string; fields: TemplateField[]; active: boolean; updatedAt: string }

const toTemplate = (r: any): SiteTemplate => ({ id: r.id, name: r.name, description: r.description, html: r.html, fields: parseJson<TemplateField[]>(r.fields, []), active: Boolean(r.active), updatedAt: new Date(r.updated_at).toISOString() });

export async function listTemplates(onlyActive = false): Promise<SiteTemplate[]> {
  return (await db().query(`SELECT * FROM site_templates ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY id`)).map(toTemplate);
}

export async function getTemplate(id: number): Promise<SiteTemplate> {
  const rows = await db().query('SELECT * FROM site_templates WHERE id = ?', [Number(id)]);
  if (!rows[0]) throw fail(404, 'Plantilla no encontrada');
  return toTemplate(rows[0]);
}

export async function saveTemplate(input: { id?: number; name?: string; description?: string; html?: string; fields?: unknown; active?: boolean }): Promise<SiteTemplate> {
  const name = String(input.name ?? '').trim();
  const html = String(input.html ?? '');
  if (!name || name.length > 120) throw fail(400, 'Ponle un nombre a la plantilla (máximo 120 caracteres).');
  if (!html.trim() || html.length > 2_000_000) throw fail(400, 'Pega el HTML de la plantilla (máximo 2 MB).');
  const fields = validateFields(input.fields ?? []);
  const vals = [name, String(input.description ?? '').slice(0, 500) || null, html, JSON.stringify(fields), input.active === false ? 0 : 1];
  if (input.id) {
    await getTemplate(input.id);
    await db().query('UPDATE site_templates SET name = ?, description = ?, html = ?, fields = ?, active = ? WHERE id = ?', [...vals, Number(input.id)]);
    return getTemplate(input.id);
  }
  const r = await db().query('INSERT INTO site_templates (name, description, html, fields, active) VALUES (?, ?, ?, ?, ?)', vals);
  return getTemplate(r.insertId);
}

// ---------- la web de una empresa ----------

export interface Site { templateId: number | null; content: Record<string, string>; published: boolean; customDomain: string | null; currency: string; paymentProvider: 'stripe' | 'mercadopago' | null }

export async function getSite(tenantId: number): Promise<Site> {
  const rows = await tenantDb(tenantId).query('SELECT * FROM sites WHERE tenant_id = :tenant');
  const r = rows[0];
  if (!r) return { templateId: null, content: {}, published: false, customDomain: null, currency: 'MXN', paymentProvider: null };
  return { templateId: r.template_id, content: parseJson(r.content, {}), published: Boolean(r.published), customDomain: r.custom_domain, currency: r.currency, paymentProvider: r.payment_provider };
}

const DOMAIN = /^(?=.{4,190}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export async function saveSite(tenantId: number, patch: { templateId?: number | null; content?: Record<string, unknown>; published?: boolean; customDomain?: string | null; currency?: string; paymentProvider?: string | null }): Promise<Site> {
  const cur = await getSite(tenantId);
  const next = { ...cur };
  if (patch.templateId !== undefined) {
    if (patch.templateId !== null) {
      const t = await getTemplate(Number(patch.templateId));
      if (!t.active) throw fail(400, 'Esa plantilla no está disponible');
    }
    next.templateId = patch.templateId === null ? null : Number(patch.templateId);
  }
  if (patch.content !== undefined) {
    const t = next.templateId ? await getTemplate(next.templateId) : null;
    // Solo se guardan los campos que la plantilla declara, limpios
    next.content = Object.fromEntries((t?.fields ?? []).filter((f) => patch.content![f.key] !== undefined).map((f) => [f.key, cleanValue(f, patch.content![f.key])]));
  }
  if (patch.published !== undefined) {
    if (patch.published && !next.templateId) throw fail(400, 'Elige una plantilla antes de publicar.');
    next.published = Boolean(patch.published);
  }
  if (patch.customDomain !== undefined) {
    const d = patch.customDomain ? String(patch.customDomain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
    if (d && !DOMAIN.test(d)) throw fail(400, 'Escribe un dominio válido, p. ej. www.mitienda.com');
    if (d && process.env.PUBLIC_HOST && d === process.env.PUBLIC_HOST.toLowerCase()) throw fail(400, 'Ese es el dominio de la plataforma');
    next.customDomain = d;
  }
  if (patch.currency !== undefined) {
    const c = String(patch.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw fail(400, 'Moneda no válida (código de 3 letras, p. ej. MXN)');
    next.currency = c;
  }
  if (patch.paymentProvider !== undefined) {
    if (patch.paymentProvider !== null && patch.paymentProvider !== 'stripe' && patch.paymentProvider !== 'mercadopago') throw fail(400, 'Forma de cobro no válida');
    next.paymentProvider = patch.paymentProvider as Site['paymentProvider'];
  }
  // Sin ON DUPLICATE KEY UPDATE: también saltaría con el dominio de OTRA empresa
  // (custom_domain es único) y sobrescribiría su web.
  const vals = [next.templateId, JSON.stringify(next.content), next.published ? 1 : 0, next.customDomain, next.currency, next.paymentProvider];
  const t = tenantDb(tenantId);
  try {
    const r = await t.query('UPDATE sites SET template_id = ?, content = ?, published = ?, custom_domain = ?, currency = ?, payment_provider = ? WHERE tenant_id = :tenant', vals);
    if (!r.affectedRows) await t.query('INSERT INTO sites (tenant_id, template_id, content, published, custom_domain, currency, payment_provider) VALUES (:tenant, ?, ?, ?, ?, ?, ?)', vals);
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw fail(409, 'Ese dominio ya lo usa otra web.');
    throw err;
  }
  return getSite(tenantId);
}

// ---------- catálogo ----------

export interface Product { id: number; name: string; description: string | null; price: number; image_url: string | null; stock: number | null; active: boolean; sort: number }

const toProduct = (r: any): Product => ({ id: r.id, name: r.name, description: r.description, price: Number(r.price), image_url: r.image_url, stock: r.stock ?? null, active: Boolean(r.active), sort: r.sort });

export async function listProducts(tenantId: number, onlyActive = false): Promise<Product[]> {
  return (await tenantDb(tenantId).query(`SELECT * FROM products WHERE tenant_id = :tenant ${onlyActive ? 'AND active = 1' : ''} ORDER BY sort, id`)).map(toProduct);
}

export async function getProduct(tenantId: number, id: number): Promise<Product> {
  const rows = await tenantDb(tenantId).query('SELECT * FROM products WHERE tenant_id = :tenant AND id = ?', [Number(id)]);
  if (!rows[0]) throw fail(404, 'Producto no encontrado');
  return toProduct(rows[0]);
}

function cleanProduct(p: Partial<Product>) {
  const name = String(p.name ?? '').trim();
  if (!name || name.length > 160) throw fail(400, 'Escribe el nombre del producto (máximo 160 caracteres).');
  const price = Math.round(Number(p.price) * 100) / 100;
  if (!(price >= 0) || price > 10_000_000) throw fail(400, 'Precio no válido.');
  const stock = p.stock === null || p.stock === undefined || (p.stock as unknown) === '' ? null : Math.max(0, Math.floor(Number(p.stock)));
  if (stock !== null && Number.isNaN(stock)) throw fail(400, 'Existencias no válidas.');
  return [name, String(p.description ?? '').slice(0, 5000) || null, price, safeUrl(p.image_url) || null, stock, p.active === false ? 0 : 1, Math.floor(Number(p.sort ?? 0)) || 0];
}

export async function saveProduct(tenantId: number, p: Partial<Product>): Promise<Product> {
  const vals = cleanProduct(p);
  const t = tenantDb(tenantId);
  if (p.id) {
    await getProduct(tenantId, p.id);
    await t.query('UPDATE products SET name = ?, description = ?, price = ?, image_url = ?, stock = ?, active = ?, sort = ? WHERE tenant_id = :tenant AND id = ?', [...vals, Number(p.id)]);
    return getProduct(tenantId, p.id);
  }
  const r = await t.query('INSERT INTO products (tenant_id, name, description, price, image_url, stock, active, sort) VALUES (:tenant, ?, ?, ?, ?, ?, ?, ?)', vals);
  return getProduct(tenantId, r.insertId);
}

// Borrar es ocultarlo: los pedidos antiguos siguen apuntando a él
export async function deleteProduct(tenantId: number, id: number): Promise<void> {
  await getProduct(tenantId, id);
  await tenantDb(tenantId).query('UPDATE products SET active = 0 WHERE tenant_id = :tenant AND id = ?', [Number(id)]);
}

// ---------- pedidos ----------

export interface OrderItem { productId: number; name: string; price: number; qty: number }
export interface Order {
  id: number; reference: string; provider: 'stripe' | 'mercadopago'; status: 'pending' | 'paid' | 'cancelled';
  customerName: string | null; customerEmail: string | null; items: OrderItem[]; total: number; currency: string; platformFee: number;
  externalId: string | null; paymentId: string | null; createdAt: string; paidAt: string | null;
}

const toOrder = (r: any): Order => ({
  id: r.id, reference: r.reference, provider: r.provider, status: r.status, customerName: r.customer_name, customerEmail: r.customer_email,
  items: parseJson<OrderItem[]>(r.items, []), total: Number(r.total), currency: r.currency, platformFee: Number(r.platform_fee),
  externalId: r.external_id, paymentId: r.payment_id, createdAt: new Date(r.created_at).toISOString(), paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
});

export async function listOrders(tenantId: number): Promise<Order[]> {
  return (await tenantDb(tenantId).query('SELECT * FROM shop_orders WHERE tenant_id = :tenant ORDER BY id DESC LIMIT 200')).map(toOrder);
}

export async function getOrderByRef(tenantId: number, reference: string): Promise<Order | null> {
  const rows = await tenantDb(tenantId).query('SELECT * FROM shop_orders WHERE tenant_id = :tenant AND reference = ?', [String(reference)]);
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function createOrder(tenantId: number, o: Omit<Order, 'id' | 'status' | 'externalId' | 'paymentId' | 'createdAt' | 'paidAt'>): Promise<Order> {
  await tenantDb(tenantId).query(
    'INSERT INTO shop_orders (tenant_id, reference, provider, customer_name, customer_email, items, total, currency, platform_fee) VALUES (:tenant, ?, ?, ?, ?, ?, ?, ?, ?)',
    [o.reference, o.provider, o.customerName, o.customerEmail, JSON.stringify(o.items), o.total, o.currency, o.platformFee],
  );
  return (await getOrderByRef(tenantId, o.reference))!;
}

export async function setOrderExternal(tenantId: number, reference: string, externalId: string): Promise<void> {
  await tenantDb(tenantId).query('UPDATE shop_orders SET external_id = ? WHERE tenant_id = :tenant AND reference = ?', [externalId, reference]);
}

// Marca un pedido como pagado una sola vez y descuenta existencias
export async function markOrderPaid(tenantId: number, reference: string, paymentId: string | null): Promise<boolean> {
  const t = tenantDb(tenantId);
  const r = await t.query("UPDATE shop_orders SET status = 'paid', paid_at = NOW(), payment_id = ? WHERE tenant_id = :tenant AND reference = ? AND status = 'pending'", [paymentId, reference]);
  if (!r.affectedRows) return false;
  const order = (await getOrderByRef(tenantId, reference))!;
  for (const it of order.items) await t.query('UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE tenant_id = :tenant AND id = ? AND stock IS NOT NULL', [it.qty, it.productId]);
  return true;
}
