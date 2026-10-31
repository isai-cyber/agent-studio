// Cobros de las webs como marketplace: cada venta se cobra a nombre de tu cliente
// (el dinero va a SU cuenta) y la plataforma se queda una comisión.
//
// Stripe Connect (cargos con destino):
//   - Tu cuenta de plataforma crea una cuenta conectada por cliente (controller
//     properties equivalentes a Express) y Stripe hace el alta (account_links).
//   - Cada pago es una Checkout Session de tu plataforma con
//     payment_intent_data[transfer_data][destination] = cuenta del cliente y
//     payment_intent_data[application_fee_amount] = tu comisión.
//   https://docs.stripe.com/connect/destination-charges
//
// Mercado Pago Marketplace:
//   - Tu cliente autoriza tu aplicación por OAuth (sin copiar claves).
//   - Cada preferencia se crea con el access_token del cliente y
//     marketplace_fee = tu comisión.
//   https://www.mercadopago.com.mx/developers/es/docs/security/oauth/creation
//
// Tus clientes no pegan ninguna clave: pulsan «Conectar» y siguen el alta.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tenantDb } from '../db/tenant-db.ts';
import { getPlatformSettings } from '../platform-settings.ts';
import { encrypt, decrypt, masterKey } from '../tenancy/crypto.ts';
import { getTenant } from '../tenancy/tenants.ts';
import { createOrder, getOrderByRef, getProduct, getSite, markOrderPaid, setOrderExternal, type Order, type OrderItem } from './store.ts';

export type Provider = 'stripe' | 'mercadopago';
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

async function api(url: string, init: RequestInit, name: string): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw fail(502, `${name} respondió ${res.status}: ${String(data?.error?.message ?? data?.message ?? text).slice(0, 200)}`);
  return data;
}

const stripeKey = () => {
  const k = getPlatformSettings().billing.stripe?.secretKey;
  if (!k) throw fail(400, 'La plataforma aún no tiene Stripe configurado (clave secreta en Ajustes).');
  return k;
};
const stripe = (path: string, form?: URLSearchParams, method = form ? 'POST' : 'GET') =>
  api(`https://api.stripe.com/v1/${path}`, { method, headers: { Authorization: `Bearer ${stripeKey()}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form }, 'Stripe');

export function marketplaceStatus() {
  const b = getPlatformSettings().billing;
  return {
    feePercent: b.marketplace?.feePercent ?? 0,
    stripe: Boolean(b.stripe?.secretKey),
    mercadopago: Boolean(b.marketplace?.mpClientId && b.marketplace?.mpClientSecret),
  };
}

export const feeOf = (total: number) => Math.round(total * (getPlatformSettings().billing.marketplace?.feePercent ?? 0)) / 100;

// ---------- cuentas de cobro de cada empresa ----------

interface AccountRow { provider: Provider; account_id: string; secrets: string | null; ready: number; expires_at: Date | null }

async function accountRow(tenantId: number, provider: Provider): Promise<AccountRow | null> {
  const rows = await tenantDb(tenantId).query('SELECT provider, account_id, secrets, ready, expires_at FROM payment_accounts WHERE tenant_id = :tenant AND provider = ?', [provider]);
  return rows[0] ?? null;
}

async function saveAccount(tenantId: number, provider: Provider, accountId: string, secrets: Record<string, string> | null, ready: boolean, expiresAt: Date | null): Promise<void> {
  const enc = secrets ? encrypt(tenantId, `payments:${provider}`, JSON.stringify(secrets)) : null;
  await tenantDb(tenantId).query(
    'INSERT INTO payment_accounts (tenant_id, provider, account_id, secrets, ready, expires_at) VALUES (:tenant, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE account_id = VALUES(account_id), secrets = COALESCE(VALUES(secrets), secrets), ready = VALUES(ready), expires_at = VALUES(expires_at)',
    [provider, accountId, enc, ready ? 1 : 0, expiresAt],
  );
}

export async function disconnectAccount(tenantId: number, provider: Provider): Promise<void> {
  await tenantDb(tenantId).query('DELETE FROM payment_accounts WHERE tenant_id = :tenant AND provider = ?', [provider]);
}

export interface AccountStatus { provider: Provider; connected: boolean; ready: boolean; accountId: string | null }

export async function accountStatus(tenantId: number): Promise<AccountStatus[]> {
  const out: AccountStatus[] = [];
  for (const provider of ['stripe', 'mercadopago'] as Provider[]) {
    const r = await accountRow(tenantId, provider);
    out.push({ provider, connected: Boolean(r), ready: Boolean(r?.ready), accountId: r ? `…${r.account_id.slice(-6)}` : null });
  }
  return out;
}

// ----- Stripe Connect -----

// Crea (si hace falta) la cuenta conectada y devuelve el enlace de alta de Stripe
export async function stripeOnboardingLink(tenantId: number, baseUrl: string): Promise<string> {
  let row = await accountRow(tenantId, 'stripe');
  if (!row) {
    const tenant = await getTenant(tenantId);
    const form = new URLSearchParams({
      'controller[stripe_dashboard][type]': 'express',
      'controller[fees][payer]': 'application',
      'controller[losses][payments]': 'application',
      'capabilities[card_payments][requested]': 'true',
      'capabilities[transfers][requested]': 'true',
      'metadata[tenant_id]': String(tenantId),
    });
    if (tenant?.country) form.set('country', tenant.country);
    if (tenant?.billingEmail) form.set('email', tenant.billingEmail);
    const acct = await stripe('accounts', form);
    await saveAccount(tenantId, 'stripe', acct.id, null, false, null);
    row = await accountRow(tenantId, 'stripe');
  }
  const link = await stripe('account_links', new URLSearchParams({
    account: row!.account_id,
    refresh_url: `${baseUrl}/oauth/stripe/refresh`,
    return_url: `${baseUrl}/?web=pagos`,
    type: 'account_onboarding',
  }));
  return link.url;
}

// ¿Ya puede cobrar? (Stripe no avisa por la URL de vuelta: se consulta la cuenta)
export async function refreshStripeAccount(tenantId: number): Promise<boolean> {
  const row = await accountRow(tenantId, 'stripe');
  if (!row) return false;
  const acct = await stripe(`accounts/${encodeURIComponent(row.account_id)}`);
  const ready = Boolean(acct.charges_enabled);
  if (ready !== Boolean(row.ready)) await saveAccount(tenantId, 'stripe', row.account_id, null, ready, null);
  return ready;
}

// ----- Mercado Pago OAuth -----

// El "state" de OAuth va firmado con la clave maestra: empresa + caducidad
function signState(tenantId: number): string {
  const payload = `${tenantId}.${Date.now() + 15 * 60_000}.${randomBytes(8).toString('hex')}`;
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
// Derivada de la clave maestra: sobrevive a reinicios y no hay que configurar nada más
const stateSecret = () => createHmac('sha256', masterKey()).update('oauth-state').digest();

export function verifyState(state: string): number | null {
  const parts = String(state ?? '').split('.');
  if (parts.length !== 4) return null;
  const [tenant, exp, nonce, sig] = parts;
  const expected = createHmac('sha256', stateSecret()).update(`${tenant}.${exp}.${nonce}`).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  return Number(tenant) || null;
}

const mpApp = () => {
  const m = getPlatformSettings().billing.marketplace;
  if (!m?.mpClientId || !m.mpClientSecret) throw fail(400, 'La plataforma aún no tiene configurada su aplicación de Mercado Pago (Ajustes → Marketplace).');
  return { clientId: m.mpClientId, clientSecret: m.mpClientSecret };
};

export const mpRedirectUri = (baseUrl: string) => `${baseUrl}/oauth/mercadopago/callback`;

export function mercadopagoAuthUrl(tenantId: number, baseUrl: string): string {
  const { clientId } = mpApp();
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', platform_id: 'mp', state: signState(tenantId), redirect_uri: mpRedirectUri(baseUrl) });
  return `https://auth.mercadopago.com/authorization?${q}`;
}

async function mpToken(body: Record<string, string>): Promise<{ access_token: string; refresh_token: string; user_id: number | string; public_key?: string; expires_in?: number }> {
  return api('https://api.mercadopago.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }, 'Mercado Pago');
}

export async function mercadopagoCallback(state: string, code: string, baseUrl: string): Promise<number> {
  const tenantId = verifyState(state);
  if (!tenantId) throw fail(400, 'La autorización caducó o no es válida. Vuelve a pulsar «Conectar Mercado Pago».');
  const { clientId, clientSecret } = mpApp();
  const t = await mpToken({ client_id: clientId, client_secret: clientSecret, code: String(code), grant_type: 'authorization_code', redirect_uri: mpRedirectUri(baseUrl) });
  await saveAccount(tenantId, 'mercadopago', String(t.user_id), { access_token: t.access_token, refresh_token: t.refresh_token, public_key: t.public_key ?? '' }, true,
    t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null);
  return tenantId;
}

// Token del vendedor, renovado si está por caducar (duran 180 días)
async function mpSellerToken(tenantId: number): Promise<string> {
  const row = await accountRow(tenantId, 'mercadopago');
  if (!row?.secrets) throw fail(400, 'Esta tienda no tiene Mercado Pago conectado.');
  const s = JSON.parse(decrypt(tenantId, 'payments:mercadopago', row.secrets)) as { access_token: string; refresh_token: string; public_key: string };
  if (row.expires_at && new Date(row.expires_at).getTime() - Date.now() < 7 * 86_400_000) {
    const { clientId, clientSecret } = mpApp();
    const t = await mpToken({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: s.refresh_token });
    await saveAccount(tenantId, 'mercadopago', String(t.user_id ?? row.account_id), { access_token: t.access_token, refresh_token: t.refresh_token || s.refresh_token, public_key: t.public_key ?? s.public_key }, true,
      t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null);
    return t.access_token;
  }
  return s.access_token;
}

// ---------- compra desde la web ----------

export interface CheckoutInput { items?: { id?: number; qty?: number }[]; name?: string; email?: string }

// Proveedor con el que cobra esta tienda: el elegido, o el único que esté listo
export async function shopProvider(tenantId: number): Promise<Provider | null> {
  const site = await getSite(tenantId);
  const status = await accountStatus(tenantId);
  const ready = status.filter((s) => s.ready).map((s) => s.provider);
  if (site.paymentProvider && ready.includes(site.paymentProvider)) return site.paymentProvider;
  return ready[0] ?? null;
}

export async function checkout(tenantId: number, input: CheckoutInput, shopUrl: string): Promise<{ url: string; reference: string }> {
  const provider = await shopProvider(tenantId);
  if (!provider) throw fail(400, 'Esta tienda todavía no acepta pagos.');
  const site = await getSite(tenantId);
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,180}\.[^\s@]{2,}$/.test(email)) throw fail(400, 'Escribe un email válido.');
  const list = Array.isArray(input.items) ? input.items.slice(0, 50) : [];
  if (!list.length) throw fail(400, 'El carrito está vacío.');
  // Los precios salen siempre del catálogo, nunca del navegador
  const items: OrderItem[] = [];
  for (const it of list) {
    const qty = Math.floor(Number(it.qty));
    if (!(qty >= 1 && qty <= 99)) throw fail(400, 'Cantidad no válida.');
    const p = await getProduct(tenantId, Number(it.id)).catch(() => null);
    if (!p || !p.active) throw fail(400, 'Un producto del carrito ya no está disponible.');
    if (p.stock !== null && p.stock < qty) throw fail(400, `No hay existencias suficientes de ${p.name}.`);
    const existing = items.find((x) => x.productId === p.id);
    if (existing) existing.qty += qty; else items.push({ productId: p.id, name: p.name, price: p.price, qty });
  }
  const total = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
  if (!(total > 0)) throw fail(400, 'El total debe ser mayor que 0.');
  const fee = feeOf(total);
  const reference = randomBytes(12).toString('hex');
  await createOrder(tenantId, { reference, provider, customerName: String(input.name ?? '').trim().slice(0, 120) || null, customerEmail: email, items, total, currency: site.currency, platformFee: fee });
  const back = `${shopUrl}/gracias?pedido=${reference}`;

  if (provider === 'stripe') {
    const row = await accountRow(tenantId, 'stripe');
    const form = new URLSearchParams({ mode: 'payment', success_url: `${back}&session_id={CHECKOUT_SESSION_ID}`, cancel_url: shopUrl, customer_email: email, client_reference_id: reference, 'metadata[order]': reference, 'metadata[tenant_id]': String(tenantId) });
    items.forEach((it, i) => {
      form.set(`line_items[${i}][quantity]`, String(it.qty));
      form.set(`line_items[${i}][price_data][currency]`, site.currency.toLowerCase());
      form.set(`line_items[${i}][price_data][unit_amount]`, String(Math.round(it.price * 100)));
      form.set(`line_items[${i}][price_data][product_data][name]`, it.name);
    });
    form.set('payment_intent_data[transfer_data][destination]', row!.account_id);
    form.set('payment_intent_data[on_behalf_of]', row!.account_id);
    if (fee > 0) form.set('payment_intent_data[application_fee_amount]', String(Math.round(fee * 100)));
    const session = await stripe('checkout/sessions', form);
    await setOrderExternal(tenantId, reference, session.id);
    return { url: session.url, reference };
  }

  const token = await mpSellerToken(tenantId);
  const pref = await api('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: items.map((it) => ({ id: String(it.productId), title: it.name, quantity: it.qty, unit_price: it.price, currency_id: site.currency })),
      payer: { email, ...(input.name ? { name: String(input.name).slice(0, 120) } : {}) },
      external_reference: reference,
      back_urls: { success: back, pending: back, failure: shopUrl },
      auto_return: 'approved',
      notification_url: `${new URL(shopUrl).origin}/webhooks/mercadopago?tenant=${tenantId}`,
      ...(fee > 0 ? { marketplace_fee: fee } : {}),
    }),
  }, 'Mercado Pago');
  await setOrderExternal(tenantId, reference, pref.id);
  return { url: pref.init_point, reference };
}

// Confirma un pedido preguntando al proveedor (vuelta del cliente o aviso del proveedor)
export async function confirmOrder(tenantId: number, reference: string, hint: { sessionId?: string; paymentId?: string } = {}): Promise<Order | null> {
  const order = await getOrderByRef(tenantId, reference);
  if (!order || order.status !== 'pending') return order;
  if (order.provider === 'stripe') {
    const id = order.externalId;
    if (!id || (hint.sessionId && hint.sessionId !== id)) return order;
    const s = await stripe(`checkout/sessions/${encodeURIComponent(id)}`);
    if (s.payment_status === 'paid' && s.metadata?.order === reference) await markOrderPaid(tenantId, reference, String(s.payment_intent ?? ''));
  } else if (hint.paymentId) {
    const p = await mercadopagoPayment(tenantId, hint.paymentId);
    if (p.status === 'approved' && p.external_reference === reference) await markOrderPaid(tenantId, reference, String(p.id));
  }
  return getOrderByRef(tenantId, reference);
}

export async function mercadopagoPayment(tenantId: number, paymentId: string): Promise<{ id: number | string; status: string; external_reference: string }> {
  if (!/^\d{1,30}$/.test(String(paymentId))) throw fail(400, 'Pago no válido');
  const token = await mpSellerToken(tenantId);
  return api(`https://api.mercadopago.com/v1/payments/${paymentId}`, { headers: { Authorization: `Bearer ${token}` } }, 'Mercado Pago');
}

// Firma de los webhooks de Stripe: cabecera Stripe-Signature (t=…,v1=…), HMAC-SHA256 de "t.cuerpo"
export function verifyStripeSignature(raw: string, header: string, secret: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
