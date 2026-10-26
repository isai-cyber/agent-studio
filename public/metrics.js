// Panel de métricas: gráficas en SVG sin dependencias.
// Paleta: slots oscuros validados sobre la superficie del gráfico (#17152f).
// Color = identidad del agente (estable), nunca su posición en el ranking.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const NS = 'http://www.w3.org/2000/svg';
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
const color = (slot) => (slot === null || slot === undefined ? 'var(--series-other)' : SERIES[slot]);
const SURFACE = 'var(--surface-chart)';

const fmtInt = new Intl.NumberFormat('es', { maximumFractionDigits: 0 });
const fmtCompact = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 });
const usd = (v) => (v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : v < 10 ? `$${v.toFixed(2)}` : `$${fmtInt.format(v)}`);
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${fmtInt.format(v)} ms`);
const dayFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });
const hourFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

let range = '7d';
let data = null;

// ---------- utilidades SVG ----------

function svg(width, height) {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el.setAttribute('height', height);
  el.setAttribute('role', 'img');
  return el;
}
function node(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}
// Escala lineal con "ticks" redondos
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function ticks(max, count = 4) {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}
// Barra horizontal con el extremo de datos redondeado (4px) y la base recta
function hbarPath(x, y, w, h, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

// ---------- tooltip ----------

const tip = () => $('#m-tip');
function showTip(evt, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const r = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > W - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > H - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
const hideTip = () => (tip().hidden = true);
const row = (label, value, c) => `<div class="tt-row"><span>${c ? `<i style="background:${c}"></i>` : ''}${esc(label)}</span><b>${esc(value)}</b></div>`;

// ---------- tabla accesible ----------

function table(card, headers, rows) {
  $('.tbl', card).innerHTML = `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function legend(card, items, dot = false) {
  $('.legend', card).innerHTML = items.length > 1 ? items.map((i) => `<span><i class="${dot ? 'dot' : ''}" style="background:${i.color}"></i>${esc(i.name)}</span>`).join('') : '';
}

const empty = (card, msg = 'Sin datos en este periodo') => ($('.plot', card).innerHTML = `<div class="empty">${esc(msg)}</div>`);

// ---------- 1. tokens en el tiempo: área apilada ----------

function chartTokens(card) {
  const { buckets, series, hourly } = data.tokensSeries;
  legend(card, series.map((s) => ({ name: s.name, color: color(s.slot) })));
  const total = buckets.map((_, i) => series.reduce((s, x) => s + x.total[i], 0));
  if (!total.some((v) => v > 0)) return empty(card);

  const plot = $('.plot', card);
  plot.innerHTML = '';
  const W = plot.clientWidth || 900;
  const H = 260;
  const m = { t: 10, r: series.length <= 4 ? 120 : 16, b: 26, l: 48 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = niceMax(Math.max(...total));
  const x = (i) => m.l + (buckets.length === 1 ? iw / 2 : (i / (buckets.length - 1)) * iw);
  const y = (v) => m.t + ih - (v / max) * ih;
  const s = svg(W, H);
  s.setAttribute('aria-label', 'Tokens en el tiempo por agente');

  for (const t of ticks(max)) {
    node(s, 'line', { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t), stroke: 'var(--grid)' });
    node(s, 'text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, fmtCompact.format(t));
  }
  const step = Math.ceil(buckets.length / Math.max(2, Math.floor(iw / 80)));
  buckets.forEach((b, i) => {
    if (i % step) return;
    node(s, 'text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, hourly ? hourFmt.format(new Date(b)) : dayFmt.format(new Date(b)));
  });

  // Áreas apiladas; el borde superior con el color de la superficie crea la separación de 2px
  const base = buckets.map(() => 0);
  const tops = [];
  for (const ser of series) {
    const lower = [...base];
    ser.total.forEach((v, i) => (base[i] += v));
    const upper = [...base];
    tops.push(upper);
    const d = `M${upper.map((v, i) => `${x(i)},${y(v)}`).join('L')}L${lower.map((v, i) => `${x(i)},${y(v)}`).reverse().join('L')}Z`;
    node(s, 'path', { d, fill: color(ser.slot), 'fill-opacity': 0.88 });
    node(s, 'path', { d: `M${upper.map((v, i) => `${x(i)},${y(v)}`).join('L')}`, fill: 'none', stroke: SURFACE, 'stroke-width': 2 });
  }
  // Etiquetas directas al final (≤ 4 series), en color de texto; la marca de color acompaña
  if (series.length <= 4) {
    const last = buckets.length - 1;
    let prevY = Infinity;
    series.forEach((ser, k) => {
      const lower = k === 0 ? 0 : tops[k - 1][last];
      let ly = y((lower + tops[k][last]) / 2) + 4;
      if (prevY - ly < 14) ly = prevY - 14;
      prevY = ly;
      node(s, 'rect', { x: m.l + iw + 8, y: ly - 8, width: 8, height: 8, rx: 2, fill: color(ser.slot) });
      node(s, 'text', { x: m.l + iw + 20, y: ly }, ser.name.length > 14 ? `${ser.name.slice(0, 13)}…` : ser.name);
    });
  }

  // Capa de hover: línea guía + tooltip
  const guide = node(s, 'line', { y1: m.t, y2: m.t + ih, stroke: 'var(--axis)', 'stroke-dasharray': '3 3', visibility: 'hidden' });
  const hit = node(s, 'rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const r = s.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(buckets.length - 1, Math.round(((px - m.l) / iw) * (buckets.length - 1))));
    guide.setAttribute('x1', x(i));
    guide.setAttribute('x2', x(i));
    guide.setAttribute('visibility', 'visible');
    const when = hourly ? `${dayFmt.format(new Date(buckets[i]))} ${hourFmt.format(new Date(buckets[i]))}` : dayFmt.format(new Date(buckets[i]));
    showTip(
      e,
      `<div class="tt-title">${esc(when)} · ${fmtInt.format(total[i])} tokens</div>` +
        [...series].reverse().map((ser) => row(ser.name, `${fmtCompact.format(ser.input[i])} ent. · ${fmtCompact.format(ser.output[i])} sal.`, color(ser.slot))).join(''),
    );
  });
  hit.addEventListener('mouseleave', () => {
    guide.setAttribute('visibility', 'hidden');
    hideTip();
  });
  plot.append(s);

  table(
    card,
    ['Periodo', ...series.flatMap((s) => [`${s.name} (entrada)`, `${s.name} (salida)`]), 'Total'],
    buckets.map((b, i) => [hourly ? hourFmt.format(new Date(b)) : dayFmt.format(new Date(b)), ...series.flatMap((s) => [fmtInt.format(s.input[i]), fmtInt.format(s.output[i])]), fmtInt.format(total[i])]),
  );
}

// ---------- 2. coste acumulado frente al presupuesto ----------

function chartCost(card) {
  const c = data.costMonth;
  const over = c.projection > c.budget;
  $('.status-line', card).innerHTML = c.spent > 0
    ? `<span class="badge ${over ? 'serious' : 'good'}">${over ? '⚠ Por encima' : '✓ Dentro'}</span> Proyección a fin de mes: <b>${usd(c.projection)}</b> de ${usd(c.budget)}`
    : '';
  if (!c.cumulative.length || c.spent === 0) return empty(card, 'Aún no hay gasto este mes');

  const plot = $('.plot', card);
  plot.innerHTML = '';
  const W = plot.clientWidth || 500;
  const H = 230;
  const m = { t: 14, r: 16, b: 26, l: 52 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = niceMax(Math.max(c.budget, c.projection, c.spent) * 1.05);
  const x = (day) => m.l + ((day - 1) / (c.daysInMonth - 1)) * iw;
  const y = (v) => m.t + ih - (v / max) * ih;
  const s = svg(W, H);
  s.setAttribute('aria-label', 'Coste acumulado del mes frente al presupuesto');

  for (const t of ticks(max)) {
    node(s, 'line', { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t), stroke: 'var(--grid)' });
    node(s, 'text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, usd(t));
  }
  for (const d of [1, 8, 15, 22, c.daysInMonth]) node(s, 'text', { x: x(d), y: H - 6, 'text-anchor': 'middle' }, `${d}`);

  // Presupuesto: referencia en tinta de texto, no en color de serie
  node(s, 'line', { x1: m.l, x2: m.l + iw, y1: y(c.budget), y2: y(c.budget), stroke: 'var(--text-secondary)', 'stroke-dasharray': '6 4', 'stroke-width': 1.5 });
  node(s, 'text', { x: m.l + iw, y: y(c.budget) - 6, 'text-anchor': 'end' }, `Presupuesto ${usd(c.budget)}`);

  const pts = c.cumulative.map((v, i) => [x(i + 1), y(v)]);
  node(s, 'path', { d: `M${pts.map((p) => p.join(',')).join('L')}`, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round' });
  // Proyección: misma serie, discontinua
  node(s, 'path', { d: `M${x(c.today)},${y(c.spent)}L${x(c.daysInMonth)},${y(c.projection)}`, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-dasharray': '4 4', 'stroke-opacity': 0.7 });
  node(s, 'circle', { cx: x(c.today), cy: y(c.spent), r: 4.5, fill: 'var(--series-1)', stroke: SURFACE, 'stroke-width': 2 });
  node(s, 'text', { x: x(c.today) - 8, y: y(c.spent) - 10, 'text-anchor': 'end', class: 't-primary' }, `${usd(c.spent)} hoy`);

  const dot = node(s, 'circle', { r: 4, fill: 'var(--series-1)', stroke: SURFACE, 'stroke-width': 2, visibility: 'hidden' });
  const hit = node(s, 'rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const r = s.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const day = Math.max(1, Math.min(c.today, Math.round(((px - m.l) / iw) * (c.daysInMonth - 1)) + 1));
    const v = c.cumulative[day - 1];
    dot.setAttribute('cx', x(day));
    dot.setAttribute('cy', y(v));
    dot.setAttribute('visibility', 'visible');
    const month = new Date(c.month);
    const daily = v - (c.cumulative[day - 2] ?? 0);
    showTip(e, `<div class="tt-title">${esc(dayFmt.format(new Date(month.getFullYear(), month.getMonth(), day)))}</div>${row('Acumulado', usd(v), 'var(--series-1)')}${row('Gasto del día', usd(daily))}${row('Presupuesto', usd(c.budget))}`);
  });
  hit.addEventListener('mouseleave', () => {
    dot.setAttribute('visibility', 'hidden');
    hideTip();
  });
  plot.append(s);
  table(card, ['Día', 'Gasto del día', 'Acumulado'], c.cumulative.map((v, i) => [`${i + 1}`, usd(v - (c.cumulative[i - 1] ?? 0)), usd(v)]));
}

// ---------- barras horizontales (ranking y latencia) ----------

function hbars(card, items, { label, value, fmt, fill, offset, tipHtml, aria }) {
  const plot = $('.plot', card);
  plot.innerHTML = '';
  const W = plot.clientWidth || 500;
  const barH = 18;
  const gap = 12;
  const labelW = Math.min(170, W * 0.36);
  const valueW = 70;
  const H = items.length * (barH + gap) + 8;
  const iw = W - labelW - valueW;
  const max = niceMax(Math.max(...items.map((it) => (offset ? offset(it) : 0) + value(it))));
  const sx = (v) => (v / max) * iw;
  const s = svg(W, H);
  s.setAttribute('aria-label', aria);
  node(s, 'line', { x1: labelW, x2: labelW, y1: 0, y2: H - 6, stroke: 'var(--axis)' });
  items.forEach((it, i) => {
    const y0 = i * (barH + gap) + 4;
    const name = label(it);
    node(s, 'text', { x: labelW - 10, y: y0 + barH / 2 + 4, 'text-anchor': 'end' }, name.length > 22 ? `${name.slice(0, 21)}…` : name);
    const x0 = labelW + (offset ? sx(offset(it)) : 0);
    const w = Math.max(2, sx(value(it)));
    node(s, 'path', { d: hbarPath(x0, y0, w, barH), fill: fill(it) });
    node(s, 'text', { x: x0 + w + 6, y: y0 + barH / 2 + 4, class: 't-primary' }, fmt(value(it)));
    const hit = node(s, 'rect', { x: 0, y: y0 - gap / 2, width: W, height: barH + gap, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => showTip(e, tipHtml(it)));
    hit.addEventListener('mouseleave', hideTip);
  });
  plot.append(s);
}

// ---------- 3. coste por agente ----------

function chartRanking(card) {
  const items = data.ranking.filter((r) => r.turns > 0);
  if (!items.length) return empty(card);
  hbars(card, items, {
    aria: 'Coste por agente',
    label: (r) => r.name,
    value: (r) => r.costUsd,
    fmt: usd,
    fill: (r) => color(r.slot),
    tipHtml: (r) => `<div class="tt-title">${esc(r.name)}</div>${row('Coste', usd(r.costUsd), color(r.slot))}${row('Tokens', fmtInt.format(r.tokens))}${row('Conversaciones', fmtInt.format(r.conversations))}${row('Mensajes', fmtInt.format(r.turns))}${row('Coste / conversación', usd(r.conversations ? r.costUsd / r.conversations : 0))}`,
  });
  table(card, ['Agente', 'Coste', 'Tokens', 'Conversaciones', 'Mensajes'], items.map((r) => [r.name, usd(r.costUsd), fmtInt.format(r.tokens), fmtInt.format(r.conversations), fmtInt.format(r.turns)]));
}

// ---------- 6. latencia por paso: cascada ----------

function chartLatency(card) {
  const steps = data.latency.steps;
  if (!steps.length) return empty(card);
  let acc = 0;
  const items = steps.map((st) => {
    const it = { ...st, start: acc };
    acc += st.avgMs;
    return it;
  });
  hbars(card, items, {
    aria: 'Latencia media por paso',
    label: (it) => it.label,
    value: (it) => it.avgMs,
    offset: (it) => it.start,
    fmt: ms,
    fill: () => 'var(--series-1)',
    tipHtml: (it) => `<div class="tt-title">${esc(it.label)}</div>${row('Media', ms(it.avgMs), 'var(--series-1)')}${row('p95', ms(it.p95Ms))}${row('Empieza en', ms(it.start))}${row('Muestras', fmtInt.format(it.count))}`,
  });
  table(card, ['Paso', 'Media', 'p95', 'Muestras'], steps.map((st) => [st.label, ms(st.avgMs), ms(st.p95Ms), fmtInt.format(st.count)]));
}

// ---------- 10. coste por resultado: dispersión ----------

function chartOutcome(card) {
  const { outcomes, points, scatterAgents } = data.conversations;
  const hasOther = points.some((p) => p.slot === null);
  legend(card, [...scatterAgents.map((a) => ({ name: a.name, color: color(a.slot) })), ...(hasOther ? [{ name: 'Otros', color: color(null) }] : [])], true);
  if (!points.length) return empty(card);

  const plot = $('.plot', card);
  plot.innerHTML = '';
  const W = plot.clientWidth || 500;
  const rowH = 52;
  const m = { t: 8, r: 16, b: 28, l: 116 };
  const H = m.t + outcomes.length * rowH + m.b;
  const iw = W - m.l - m.r;
  const max = niceMax(Math.max(...points.map((p) => p.costUsd)));
  const x = (v) => m.l + (v / max) * iw;
  const s = svg(W, H);
  s.setAttribute('aria-label', 'Coste por conversación según su resultado');

  for (const t of ticks(max)) {
    node(s, 'line', { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, stroke: 'var(--grid)' });
    node(s, 'text', { x: x(t), y: H - 8, 'text-anchor': 'middle' }, usd(t));
  }
  // Pseudoaleatorio estable para repartir los puntos dentro de cada fila
  const jitter = (id) => {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (h % 1000) / 1000 - 0.5;
  };
  outcomes.forEach((o, i) => {
    const cy = m.t + i * rowH + rowH / 2;
    const n = points.filter((p) => p.outcome === o).length;
    node(s, 'text', { x: m.l - 12, y: cy, 'text-anchor': 'end', class: 't-primary' }, o);
    node(s, 'text', { x: m.l - 12, y: cy + 14, 'text-anchor': 'end' }, `${fmtInt.format(n)} conv.`);
    if (i) node(s, 'line', { x1: m.l, x2: m.l + iw, y1: m.t + i * rowH, y2: m.t + i * rowH, stroke: 'var(--grid)' });
  });
  // Los "Otros" debajo para que los agentes con color queden visibles
  const sorted = [...points].sort((a, b) => (a.slot === null ? -1 : 0) - (b.slot === null ? -1 : 0));
  for (const p of sorted) {
    const i = outcomes.indexOf(p.outcome);
    const cy = m.t + i * rowH + rowH / 2 + jitter(p.sessionId) * (rowH * 0.62);
    const dot = node(s, 'circle', { cx: x(p.costUsd), cy, r: 4.5, fill: color(p.slot), 'fill-opacity': 0.85, stroke: SURFACE, 'stroke-width': 2 });
    dot.addEventListener('mousemove', (e) => {
      dot.setAttribute('r', 6.5);
      showTip(e, `<div class="tt-title">${esc(p.name)}</div>${row('Resultado', p.outcome, color(p.slot))}${row('Coste', usd(p.costUsd))}${row('Tokens', fmtInt.format(p.tokens))}${row('Mensajes', fmtInt.format(p.turns))}${row('Inicio', dayFmt.format(new Date(p.started)))}`);
    });
    dot.addEventListener('mouseleave', () => {
      dot.setAttribute('r', 4.5);
      hideTip();
    });
  }
  plot.append(s);

  // Tabla resumida por resultado y agente (más útil que una fila por punto)
  const groups = new Map();
  for (const p of points) {
    const k = `${p.outcome}|${p.name}`;
    const g = groups.get(k) ?? { outcome: p.outcome, name: p.name, n: 0, cost: 0, tokens: 0 };
    g.n++;
    g.cost += p.costUsd;
    g.tokens += p.tokens;
    groups.set(k, g);
  }
  table(
    card,
    ['Resultado', 'Agente', 'Conversaciones', 'Coste medio', 'Tokens medios'],
    [...groups.values()].sort((a, b) => outcomes.indexOf(a.outcome) - outcomes.indexOf(b.outcome) || b.n - a.n).map((g) => [g.outcome, g.name, fmtInt.format(g.n), usd(g.cost / g.n), fmtInt.format(g.tokens / g.n)]),
  );
}

// ---------- KPIs, banner y carga ----------

function kpis() {
  const k = data.kpis;
  const tiles = [
    ['Tokens', fmtCompact.format(k.tokens), k.unknownTokenTurns ? `${fmtInt.format(k.unknownTokenTurns)} mensajes vía NanoClaw sin cifra de tokens` : `${fmtInt.format(k.turns)} mensajes`],
    ['Coste', usd(k.costUsd), `Precios: $${data.prices.input}/M entrada · $${data.prices.output}/M salida`],
    ['Conversaciones', fmtInt.format(k.conversations), k.conversations ? `${(k.turns / k.conversations).toFixed(1)} mensajes de media` : '—'],
    ['Latencia', ms(k.p50LatencyMs), `p95 ${ms(k.p95LatencyMs)}${k.errors ? ` · ${k.errors} errores` : ''}`],
  ];
  $('#m-kpis').innerHTML = tiles.map(([l, v, sub]) => `<div class="kpi"><div class="k-label">${esc(l)}</div><div class="k-value">${esc(v)}</div><div class="k-sub">${esc(sub)}</div></div>`).join('');
}

function banner(api) {
  const el = $('#m-banner');
  if (data.demo) {
    el.innerHTML = `<div class="m-banner"><span>📊 Estás viendo <b>datos de ejemplo</b> mezclados con los reales.</span><button class="ghost" id="m-clear">Quitar datos de ejemplo</button></div>`;
    $('#m-clear').onclick = async () => {
      await api('/api/metrics/demo', { method: 'DELETE' });
      load(api);
    };
  } else if (!data.kpis.turns) {
    el.innerHTML = `<div class="m-banner"><span>Todavía no hay mensajes registrados. Habla con un agente o genera datos de ejemplo para ver el panel.</span><button class="primary" id="m-demo">Generar datos de ejemplo</button></div>`;
    $('#m-demo').onclick = async () => {
      await api('/api/metrics/demo', { method: 'POST' });
      load(api);
    };
  } else el.innerHTML = '';
}

const CHARTS = { tokens: chartTokens, cost: chartCost, ranking: chartRanking, latency: chartLatency, outcome: chartOutcome };

function renderAll() {
  if (!data) return;
  kpis();
  for (const [key, fn] of Object.entries(CHARTS)) fn($(`[data-chart="${key}"]`));
  $('#m-foot').textContent = `Actualizado ${hourFmt.format(new Date(data.generatedAt))}. Coste estimado con los precios configurados en .env (PRICE_INPUT_PER_M, PRICE_OUTPUT_PER_M, MONTHLY_BUDGET_USD).`;
}

// La araña de "Agente en vivo" recibe los mismos datos del panel
function sendToLive() {
  const f = document.getElementById('live-frame');
  if (f?.contentWindow && data) f.contentWindow.postMessage({ type: 'metrics', data }, location.origin);
}

export async function load(api) {
  data = await api(`/api/metrics?range=${range}`);
  banner(api);
  renderAll();
  sendToLive();
}

export function initMetrics(api) {
  document.querySelectorAll('#view-metrics [data-range]').forEach(
    (b) =>
      (b.onclick = () => {
        range = b.dataset.range;
        document.querySelectorAll('#view-metrics [data-range]').forEach((x) => x.classList.toggle('active', x === b));
        load(api);
      }),
  );
  document.querySelectorAll('#view-metrics .tbl-toggle').forEach(
    (b) =>
      (b.onclick = () => {
        const t = $('.tbl', b.closest('.chart-card'));
        t.hidden = !t.hidden;
        b.textContent = t.hidden ? 'Ver tabla' : 'Ver gráfica';
        $('.plot', b.closest('.chart-card')).hidden = !t.hidden;
      }),
  );
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data?.type === 'flow-ready') sendToLive();
  });
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => $('#view-metrics').classList.contains('active') && renderAll(), 150);
  });
}
