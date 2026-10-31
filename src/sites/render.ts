// Motor de plantillas de las webs. Las plantillas las sube el superadmin (HTML de
// confianza); el contenido lo escribe cada empresa y SIEMPRE se escapa.
//
//   {{campo}}                 valor de un campo editable (definido en los campos de la plantilla)
//   {{empresa}}               nombre de la empresa
//   {{#productos}}…{{/productos}}  repite el bloque por cada producto activo, con:
//       {{nombre}} {{descripcion}} {{precio}} {{imagen}} {{id}} {{comprar}}
//   {{carrito}}               botón del carrito (si la plantilla no lo pone, se añade solo)
//
// {{comprar}} y {{carrito}} los genera la plataforma; el carrito y el pago los
// maneja public/site-shop.js, que se inyecta en todas las webs.

export type FieldType = 'text' | 'textarea' | 'image' | 'url' | 'color';
export interface TemplateField { key: string; label: string; type: FieldType; default?: string }

export interface RenderProduct { id: number; name: string; description: string | null; price: number; image_url: string | null; stock: number | null }

const fail = (message: string) => Object.assign(new Error(message), { status: 400 });

// Las llaves también se escapan: un texto del cliente nunca puede colar un {{marcador}}
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"'{}]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' })[c]!);

// Solo enlaces http(s) o rutas propias: nunca javascript:, data:…
export function safeUrl(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*)$/i.test(s) && !s.startsWith('//') ? s : '';
}

export function cleanValue(field: TemplateField, v: unknown): string {
  const s = String(v ?? '').slice(0, field.type === 'textarea' ? 5000 : 500);
  if (field.type === 'image' || field.type === 'url') return safeUrl(s);
  if (field.type === 'color') return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s.trim()) ? s.trim() : '';
  return s;
}

export function validateFields(fields: unknown): TemplateField[] {
  if (!Array.isArray(fields)) throw fail('Los campos deben ser una lista');
  const seen = new Set<string>();
  return fields.map((f: any) => {
    const key = String(f?.key ?? '');
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key) || ['empresa', 'productos', 'carrito', 'comprar', 'nombre', 'descripcion', 'precio', 'imagen', 'id'].includes(key)) throw fail(`Clave de campo no válida o reservada: ${key}`);
    if (seen.has(key)) throw fail(`Campo repetido: ${key}`);
    seen.add(key);
    const type = (['text', 'textarea', 'image', 'url', 'color'].includes(f.type) ? f.type : 'text') as FieldType;
    return { key, label: String(f.label ?? key).slice(0, 80), type, ...(f.default !== undefined ? { default: String(f.default).slice(0, 5000) } : {}) };
  });
}

// Campos que usa el HTML y no están declarados (para avisar al superadmin)
export function undeclaredFields(html: string, fields: TemplateField[]): string[] {
  const reserved = new Set(['empresa', 'carrito', 'nombre', 'descripcion', 'precio', 'imagen', 'id', 'comprar']);
  const used = [...html.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(used.filter((k) => !reserved.has(k) && !fields.some((f) => f.key === k)))];
}

const money = (n: number, currency: string, lang: string) => {
  try { return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'es-MX', { style: 'currency', currency }).format(n); } catch { return `${n.toFixed(2)} ${currency}`; }
};

export function renderSite(opts: {
  html: string; fields: TemplateField[]; content: Record<string, unknown>; tenantName: string; products: RenderProduct[];
  currency: string; language: string; shopBase: string; canBuy: boolean;
}): string {
  const values: Record<string, string> = { empresa: esc(opts.tenantName) };
  for (const f of opts.fields) values[f.key] = esc(cleanValue(f, opts.content[f.key] ?? f.default ?? ''));
  const buyLabel = opts.language === 'en' ? 'Add to cart' : 'Agregar al carrito';
  const soldOut = opts.language === 'en' ? 'Sold out' : 'Agotado';
  const cart = `<button type="button" class="as-cart-btn" data-as-cart>${opts.language === 'en' ? 'Cart' : 'Carrito'} (<span data-as-count>0</span>)</button>`;

  let out = opts.html.replace(/\{\{#productos\}\}([\s\S]*?)\{\{\/productos\}\}/g, (_m, block: string) =>
    opts.products.map((p) => {
      const pv: Record<string, string> = {
        ...values,
        id: String(p.id), nombre: esc(p.name), descripcion: esc(p.description ?? ''), precio: esc(money(p.price, opts.currency, opts.language)),
        imagen: esc(safeUrl(p.image_url)),
        comprar: !opts.canBuy ? '' : p.stock !== null && p.stock <= 0 ? `<span class="as-soldout">${soldOut}</span>`
          : `<button type="button" class="as-buy" data-as-buy="${p.id}" data-name="${esc(p.name)}" data-price="${p.price}">${buyLabel}</button>`,
      };
      return block.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_x, k: string) => pv[k] ?? '');
    }).join(''));
  const hasCart = /\{\{\s*carrito\s*\}\}/.test(out);
  out = out.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_x, k: string) => (k === 'carrito' ? (opts.canBuy ? cart : '') : values[k] ?? ''));
  // Carrito y pago: lo pone la plataforma en todas las webs
  const inject = `${opts.canBuy && !hasCart ? `<div class="as-cart-float">${cart}</div>` : ''}<script src="/site-shop.js" data-shop="${esc(opts.shopBase)}" data-currency="${esc(opts.currency)}" data-lang="${esc(opts.language)}" defer></script>`;
  return /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${inject}</body>`) : out + inject;
}
