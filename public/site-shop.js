// Carrito y pago de las webs de las empresas. Lo inyecta la plataforma en todas
// las webs (sites/render.ts): botones [data-as-buy], botón [data-as-cart].
// Los precios que se muestran aquí son orientativos: el servidor los toma del catálogo.
(() => {
  const me = document.currentScript;
  const base = me?.dataset.shop || '';
  if (!base) return; // vista previa: sin compra
  const currency = me.dataset.currency || 'MXN';
  const en = me.dataset.lang === 'en';
  const t = en
    ? { cart: 'Your cart', empty: 'Your cart is empty.', total: 'Total', name: 'Name', email: 'Email', pay: 'Pay', close: 'Close', remove: 'Remove', wait: 'Redirecting to payment…', added: 'Added to cart' }
    : { cart: 'Tu carrito', empty: 'Tu carrito está vacío.', total: 'Total', name: 'Nombre', email: 'Email', pay: 'Pagar', close: 'Cerrar', remove: 'Quitar', wait: 'Te llevamos al pago…', added: 'Agregado al carrito' };
  const KEY = `as-cart:${base}`;
  const money = (n) => { try { return new Intl.NumberFormat(en ? 'en-US' : 'es-MX', { style: 'currency', currency }).format(n); } catch { return `${n.toFixed(2)} ${currency}`; } };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  let cart = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch {} count(); };
  const count = () => document.querySelectorAll('[data-as-count]').forEach((el) => { el.textContent = String(cart.reduce((s, i) => s + i.qty, 0)); });

  const css = document.createElement('style');
  css.textContent = `.as-cart-float{position:fixed;right:16px;bottom:16px;z-index:9998}
.as-cart-btn,.as-buy{cursor:pointer;border:0;border-radius:8px;padding:10px 16px;font:inherit;background:#111;color:#fff}
.as-soldout{opacity:.6}
.as-panel{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;justify-content:flex-end}
.as-panel>div{background:#fff;color:#111;width:min(420px,100%);height:100%;overflow:auto;padding:20px;box-sizing:border-box;font-family:system-ui,sans-serif}
.as-panel h2{margin:0 0 12px}.as-row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee}
.as-row input{width:56px}.as-panel label{display:block;margin:10px 0 4px}.as-panel input[type=text],.as-panel input[type=email]{width:100%;padding:8px;box-sizing:border-box}
.as-panel .as-pay{width:100%;margin-top:14px}.as-panel .as-x{background:none;border:0;font-size:22px;float:right;cursor:pointer}
.as-err{color:#b91c1c}.as-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:8px;z-index:10000}`;
  document.head.appendChild(css);

  const toast = (msg) => { const d = document.createElement('div'); d.className = 'as-toast'; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 1600); };

  function open() {
    const wrap = document.createElement('div');
    wrap.className = 'as-panel';
    const box = document.createElement('div');
    wrap.appendChild(box);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    const render = () => {
      box.replaceChildren();
      const x = Object.assign(document.createElement('button'), { className: 'as-x', textContent: '×', title: t.close, onclick: () => wrap.remove() });
      box.append(x, Object.assign(document.createElement('h2'), { textContent: t.cart }));
      if (!cart.length) { box.append(Object.assign(document.createElement('p'), { textContent: t.empty })); return; }
      for (const it of cart) {
        const row = document.createElement('div');
        row.className = 'as-row';
        const name = Object.assign(document.createElement('span'), { textContent: `${it.name} · ${money(it.price)}` });
        const qty = Object.assign(document.createElement('input'), { type: 'number', min: 1, max: 99, value: it.qty });
        qty.onchange = () => { it.qty = Math.max(1, Math.min(99, Number(qty.value) || 1)); save(); render(); };
        const rm = Object.assign(document.createElement('button'), { type: 'button', textContent: t.remove, onclick: () => { cart = cart.filter((c) => c !== it); save(); render(); } });
        row.append(name, qty, rm);
        box.append(row);
      }
      box.append(Object.assign(document.createElement('p'), { innerHTML: `<b>${t.total}: </b>` }));
      box.lastChild.append(money(cart.reduce((s, i) => s + i.price * i.qty, 0)));
      const form = document.createElement('form');
      form.innerHTML = `<label>${t.name}</label><input type="text" name="name" maxlength="120" autocomplete="name"><label>${t.email}</label><input type="email" name="email" required maxlength="200" autocomplete="email"><p class="as-err"></p>`;
      const pay = Object.assign(document.createElement('button'), { type: 'submit', className: 'as-buy as-pay', textContent: t.pay });
      form.append(pay);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const err = form.querySelector('.as-err');
        err.textContent = '';
        pay.disabled = true;
        pay.textContent = t.wait;
        try {
          const r = await fetch(`${base}/checkout`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: form.name.value, email: form.email.value, items: cart.map((i) => ({ id: i.id, qty: i.qty })) }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.url) throw new Error(data.error || r.statusText);
          location.href = data.url;
        } catch (ex) {
          err.textContent = ex.message;
          pay.disabled = false;
          pay.textContent = t.pay;
        }
      };
      box.append(form);
    };
    render();
    document.body.appendChild(wrap);
  }

  document.addEventListener('click', (e) => {
    const buy = e.target.closest?.('[data-as-buy]');
    if (buy) {
      const id = Number(buy.dataset.asBuy);
      const found = cart.find((c) => c.id === id);
      if (found) found.qty = Math.min(99, found.qty + 1);
      else cart.push({ id, name: buy.dataset.name || '', price: Number(buy.dataset.price) || 0, qty: 1 });
      save();
      toast(t.added);
      return;
    }
    if (e.target.closest?.('[data-as-cart]')) open();
  });
  count();
})();
