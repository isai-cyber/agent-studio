// Cobros de la plataforma a sus clientes (empresas). El superadmin elige para
// cada empresa si se le cobra con Stripe o con Mercado Pago y pone sus propias
// credenciales en Empresas y planes → Ajustes. Cada cobro genera un enlace de
// pago (Stripe Checkout o preferencia de Mercado Pago) que ve el Propietario de
// la empresa en su facturación; el estado se comprueba contra el proveedor.
import { tenantDb } from './db/tenant-db.ts';
import { getPlatformSettings } from './platform-settings.ts';
import { getTenant, type BillingProvider } from './tenancy/tenants.ts';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export interface Charge {
  id: number; provider: BillingProvider; description: string; amount: number; currency: string;
  url: string | null; status: 'pending' | 'paid' | 'cancelled'; createdAt: string; paidAt: string | null;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const toCharge = (r: any): Charge => ({ id: r.id, provider: r.provider, description: r.description, amount: Number(r.amount), currency: r.currency, url: r.url, status: r.status, createdAt: iso(r.created_at)!, paidAt: iso(r.paid_at) });

export function billingStatus() {
  const b = getPlatformSettings().billing;
  return {
    stripe: { configured: Boolean(b.stripe?.secretKey), currency: b.stripe?.currency ?? 'USD' },
    mercadopago: { configured: Boolean(b.mercadopago?.accessToken), currency: b.mercadopago?.currency ?? 'MXN' },
  };
}

export async function listCharges(tenantId: number): Promise<Charge[]> {
  return (await tenantDb(tenantId).query('SELECT * FROM billing_charges WHERE tenant_id = :tenant ORDER BY id DESC LIMIT 100')).map(toCharge);
}

async function getCharge(tenantId: number, id: number): Promise<Charge & { externalId: string | null }> {
  const rows = await tenantDb(tenantId).query('SELECT * FROM billing_charges WHERE tenant_id = :tenant AND id = ?', [Number(id)]);
  if (!rows[0]) throw fail(404, 'Cobro no encontrado');
  return { ...toCharge(rows[0]), externalId: rows[0].external_id };
}

async function api(url: string, init: RequestInit, name: string): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw fail(502, `${name} respondió ${res.status}: ${(data?.error?.message ?? data?.message ?? text).toString().slice(0, 200)}`);
  return data;
}

export async function createCharge(tenantId: number, input: { amount?: number; currency?: string; description?: string }, actorUserId: number | null, baseUrl: string): Promise<Charge> {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw fail(404, 'Empresa no encontrada');
  const provider = tenant.billingProvider;
  if (!provider) throw fail(400, `Elige antes con qué se cobra a ${tenant.name} (Stripe o Mercado Pago).`);
  const s = getPlatformSettings().billing;
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!(amount > 0) || amount > 1_000_000) throw fail(400, 'Escribe un importe mayor que 0.');
  const description = String(input.description ?? '').trim().slice(0, 190) || `Servicio Agent Studio · ${tenant.name}`;
  const t = tenantDb(tenantId);
  const returnUrl = s.successUrl || baseUrl;
  let currency: string, url: string, externalId: string;
  if (provider === 'stripe') {
    const key = s.stripe?.secretKey;
    if (!key) throw fail(400, 'Falta la clave secreta de Stripe en Ajustes.');
    currency = String(input.currency || s.stripe?.currency || 'USD').toUpperCase();
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: returnUrl,
      cancel_url: returnUrl,
      client_reference_id: `tenant-${tenantId}`,
      'metadata[tenant_id]': String(tenantId),
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)),
      'line_items[0][price_data][product_data][name]': description,
    });
    if (tenant.billingEmail) form.set('customer_email', tenant.billingEmail);
    const d = await api('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }, 'Stripe');
    url = d.url;
    externalId = d.id;
  } else {
    const token = s.mercadopago?.accessToken;
    if (!token) throw fail(400, 'Falta el access token de Mercado Pago en Ajustes.');
    currency = String(input.currency || s.mercadopago?.currency || 'MXN').toUpperCase();
    // La referencia externa permite encontrar el pago después
    const reference = `agent-studio-${tenantId}-${Date.now()}`;
    const d = await api('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ title: description, quantity: 1, unit_price: amount, currency_id: currency }],
        external_reference: reference,
        back_urls: { success: returnUrl, failure: returnUrl, pending: returnUrl },
        ...(tenant.billingEmail ? { payer: { email: tenant.billingEmail } } : {}),
      }),
    }, 'Mercado Pago');
    url = d.init_point;
    externalId = reference;
  }
  if (!url) throw fail(502, 'El proveedor no devolvió un enlace de pago.');
  const r = await t.query('INSERT INTO billing_charges (tenant_id, provider, description, amount, currency, external_id, url, created_by) VALUES (:tenant, ?, ?, ?, ?, ?, ?, ?)', [provider, description, amount, currency, externalId, url, actorUserId]);
  return getCharge(tenantId, r.insertId);
}

// Pregunta al proveedor si ya se pagó
export async function refreshCharge(tenantId: number, id: number): Promise<Charge> {
  const c = await getCharge(tenantId, id);
  if (c.status !== 'pending' || !c.externalId) return c;
  const s = getPlatformSettings().billing;
  let paid = false;
  if (c.provider === 'stripe') {
    if (!s.stripe?.secretKey) throw fail(400, 'Falta la clave secreta de Stripe en Ajustes.');
    const d = await api(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(c.externalId)}`, { headers: { Authorization: `Bearer ${s.stripe.secretKey}` } }, 'Stripe');
    paid = d.payment_status === 'paid';
  } else {
    if (!s.mercadopago?.accessToken) throw fail(400, 'Falta el access token de Mercado Pago en Ajustes.');
    const d = await api(`https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(c.externalId)}`, { headers: { Authorization: `Bearer ${s.mercadopago.accessToken}` } }, 'Mercado Pago');
    paid = (d.results ?? []).some((p: { status?: string }) => p.status === 'approved');
  }
  if (paid) await tenantDb(tenantId).query("UPDATE billing_charges SET status = 'paid', paid_at = NOW() WHERE tenant_id = :tenant AND id = ?", [id]);
  return getCharge(tenantId, id);
}

// Marcar a mano (p. ej. pagó por transferencia) o anular
export async function setChargeStatus(tenantId: number, id: number, status: 'paid' | 'cancelled' | 'pending'): Promise<{ before: Charge; after: Charge }> {
  if (!['paid', 'cancelled', 'pending'].includes(status)) throw fail(400, 'Estado no válido');
  const before = await getCharge(tenantId, id);
  await tenantDb(tenantId).query('UPDATE billing_charges SET status = ?, paid_at = ? WHERE tenant_id = :tenant AND id = ?', [status, status === 'paid' ? new Date() : null, id]);
  return { before, after: await getCharge(tenantId, id) };
}
