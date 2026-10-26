// Automatizaciones con un editor estilo Zapier/Automatisch: tarjetas en una columna,
// "+" entre pasos, y cada tarjeta se despliega en: elegir app y evento → configurar → probar.
// También: catálogo de módulos y plantillas de flujo.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => Math.random().toString(36).slice(2, 8);

let api, post;
let modules = [];
let agents = [];
let connections = {}; // app → campos guardados (enmascarados)
let flow = null;
let lastRun = null;
let open = { card: null, section: 'app', pickModule: null }; // tarjeta abierta ('trigger' | id de paso)
let saveTimer = null;
let varMenuFor = null; // campo para el que está abierto el menú de datos
let caret = { key: null, pos: null }; // posición del cursor en el último campo editado

const modByKey = (k) => modules.find((m) => m.key === k);

// ---------- logos ----------
const ICON_BOLT = '<svg class="lg-svg" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
const ICON_PLUS = '<svg class="lg-svg" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
// Logo de la app; si no tiene o no carga, su inicial
export function logo(m) {
  const letter = esc(String(m?.name ?? '?').replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '·');
  if (!m?.logo) return `<b class="lg-fb">${letter}</b>`;
  return `<img class="lg" src="${esc(m.logo)}" alt="" loading="lazy" decoding="async" data-fb="${letter}">`;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('lg')) return;
  const b = document.createElement('b');
  b.className = 'lg-fb';
  b.textContent = img.dataset.fb ?? '·';
  img.replaceWith(b);
}, true);

// Tipo de módulo (pestañas del marketplace) y orden: básicos y apps nativas primero
export function kindOf(m) {
  if (m.source === 'comunidad') return 'comunidad';
  if (m.badge === 'MCP' || m.key === 'mcp') return 'mcp';
  if (m.badge === 'API' || m.key === 'openapi') return 'api';
  return m.auth ? 'app' : 'basico';
}
const RANK = { basico: 0, app: 1, comunidad: 2, mcp: 3, api: 4 };
const byRank = (a, b) => RANK[kindOf(a)] - RANK[kindOf(b)] || Number(!/\.svg$/.test(a.logo ?? '')) - Number(!/\.svg$/.test(b.logo ?? '')) || a.name.localeCompare(b.name, 'es');
const eventDef = (card) => {
  if (!card?.module) return null;
  const m = modByKey(card.module);
  return card.kind === 'trigger' ? m?.triggers.find((t) => t.key === card.key) : m?.actions.find((a) => a.key === card.key);
};
const STATUS = { ok: '✓', error: '✕', filtrado: '⏸', omitido: '–' };

// ---------- plantillas ----------

const TEMPLATES = [
  {
    icon: '🚨', name: 'Avisar en Slack cuando un agente escala a una persona',
    flow: { name: 'Escalados → Slack', trigger: { module: 'agent-studio', key: 'agent-turn', args: { topic: 'Hablar con una persona' } },
      steps: [{ module: 'mensajeria', key: 'slack', name: 'Avisar al equipo', args: { webhookUrl: '{{env.FLOW_SLACK_WEBHOOK}}', text: '🚨 {{trigger.agentName}} necesita a una persona.\nCliente: "{{trigger.message}}"' } }] },
  },
  {
    icon: '🔗', name: 'Recibir un webhook y responder con un agente',
    flow: { name: 'Webhook → agente', trigger: { module: 'core', key: 'webhook', args: {} },
      steps: [{ module: 'agent-studio', key: 'chat', name: 'Preguntar al agente', args: { agentId: 'soporte-al-cliente', message: '{{trigger.body.mensaje}}' } }] },
  },
  {
    icon: '🌤️', name: 'Enviar el clima cada mañana por Telegram',
    flow: { name: 'Clima diario → Telegram', trigger: { module: 'core', key: 'schedule', args: { everyMinutes: 1440 } },
      steps: [
        { module: 'apis-publicas', key: 'weather', name: 'Consultar el clima', args: { city: 'Ciudad de México' } },
        { module: 'mensajeria', key: 'telegram', name: 'Enviar por Telegram', args: { token: '{{env.FLOW_TELEGRAM_TOKEN}}', chatId: '', text: 'Buenos días ☀️ {{steps.paso1.resumen}}' } },
      ] },
  },
];

// ---------- carga ----------

async function loadMeta() {
  [modules, agents, connections] = await Promise.all([api('/api/modules').then((r) => r.modules.sort(byRank)), api('/api/agents'), api('/api/connections')]);
}

export async function loadFlowsView() {
  await loadMeta();
  if (flow) return renderEditor();
  $('#flows-editor').hidden = true;
  $('#flows-list').hidden = false;
  const flows = await api('/api/flows');
  const runs = await Promise.all(flows.map((f) => api(`/api/flows/${f.id}/runs`).then((r) => r[0]).catch(() => null)));
  $('#flows-templates').innerHTML = TEMPLATES.map((t, i) => `<button class="tpl" data-tpl="${i}"><span class="tpl-logos">${[t.flow.trigger, ...t.flow.steps].map((s) => `<i>${logo(modByKey(s.module))}</i>`).join('')}</span>${esc(t.name)}</button>`).join('');
  $$('#flows-templates .tpl').forEach((b) => (b.onclick = () => createFromTemplate(TEMPLATES[+b.dataset.tpl])));
  $('#flows-grid').innerHTML = flows.length
    ? flows
        .map((f, i) => {
          const m = f.trigger ? modByKey(f.trigger.module) : null;
          const r = runs[i];
          return `<div class="card flow-card" data-id="${esc(f.id)}">
            <div class="flow-card-head"><span class="flow-steps">${[f.trigger, ...f.steps].filter(Boolean).map((s) => `<span>${logo(modByKey(s.module))}</span>`).join('<i>›</i>')}</span>
              <span class="pill-state ${f.active ? 'on' : ''}">${f.active ? 'Publicado' : 'Borrador'}</span></div>
            <div class="name">${esc(f.name)}</div>
            <div class="muted small">${r ? `Última ejecución: ${STATUS[r.status] ?? ''} ${esc(r.status)} · ${new Date(r.ts).toLocaleString('es')}` : 'Sin ejecuciones todavía'}</div>
          </div>`;
        })
        .join('')
    : '<p class="muted">Aún no tienes automatizaciones. Empieza con una plantilla o crea una desde cero.</p>';
  $$('#flows-grid .flow-card').forEach((c) => (c.onclick = async () => openFlow(await api(`/api/flows/${c.dataset.id}`))));
}

async function createFromTemplate(t) {
  const ids = t.flow.steps.map((_, i) => `paso${i + 1}`);
  const f = await post('/api/flows', { ...structuredClone(t.flow), active: false, steps: t.flow.steps.map((s, i) => ({ ...structuredClone(s), id: ids[i] })) });
  openFlow(f);
}

async function openFlow(f) {
  flow = f;
  lastRun = f.id ? (await api(`/api/flows/${f.id}/runs`))[0] ?? null : null;
  const firstIncomplete = cards().find((c) => !isComplete(c));
  open = { card: firstIncomplete ? firstIncomplete.id : null, section: !firstIncomplete?.module ? 'app' : isConnected(firstIncomplete.module) ? 'setup' : 'conn', pickModule: null };
  renderEditor();
}

// ---------- modelo de tarjetas ----------

// Disparador + pasos como una lista uniforme de "tarjetas"
function cards() {
  const t = flow.trigger ?? {};
  return [{ id: 'trigger', kind: 'trigger', module: t.module, key: t.key, args: t.args ?? {} }, ...flow.steps.map((s) => ({ ...s, kind: 'action' }))];
}
function cardRef(id) {
  if (id === 'trigger') return (flow.trigger ??= { module: undefined, key: undefined, args: {} });
  return flow.steps.find((s) => s.id === id);
}
function missingRequired(card) {
  const def = eventDef(card);
  return (def?.arguments ?? []).filter((a) => a.required && (card.args?.[a.key] === undefined || card.args?.[a.key] === ''));
}
function runOf(id) {
  return id === 'trigger' ? (lastRun ? { status: 'ok', output: lastRun.trigger } : null) : lastRun?.steps.find((s) => s.id === id);
}
// ¿La app de la tarjeta tiene guardados todos los datos de conexión que pide?
function isConnected(moduleKey) {
  const auth = modByKey(moduleKey)?.auth;
  if (!auth) return true;
  const saved = connections[moduleKey] ?? {};
  return auth.fields.every((f) => f.optional || saved[f.key]);
}
function isComplete(card) {
  return Boolean(card.module && card.key && eventDef(card) && isConnected(card.module) && !missingRequired(card).length);
}

// ---------- guardado automático ----------

function changed() {
  $('#flow-msg').textContent = 'Guardando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}
async function save() {
  clearTimeout(saveTimer);
  flow.name = $('#flow-name').value.trim() || 'Flujo sin nombre';
  if (flow.trigger && !flow.trigger.module) flow.trigger = null;
  const body = JSON.stringify(flow);
  const saved = flow.id ? await api(`/api/flows/${flow.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }) : await post('/api/flows', flow);
  flow.id = saved.id;
  $('#flow-msg').textContent = '✓ Guardado';
  renderTop();
}

// ---------- editor ----------

function renderTop() {
  $('#flow-name').value = flow.name;
  const pub = $('#flow-publish');
  pub.textContent = flow.active ? 'PAUSAR' : 'PUBLICAR';
  pub.classList.toggle('primary', !flow.active);
  $('#flow-state').textContent = flow.active ? '● Publicado' : 'Borrador';
  $('#flow-state').className = `flow-state ${flow.active ? 'on' : ''}`;
  $('#run-bar').innerHTML = lastRun ? `Última prueba: <b class="s-${esc(lastRun.status)}">${STATUS[lastRun.status] ?? ''} ${esc(lastRun.status)}</b> · ${lastRun.ms} ms` : '';
}

function renderEditor() {
  $('#flows-list').hidden = true;
  $('#flows-editor').hidden = false;
  renderTop();
  const list = cards();
  $('#zap').innerHTML =
    list.map((c, i) => (i > 0 ? plusHtml(i - 1) : '') + cardHtml(c, i)).join('') +
    plusHtml(flow.steps.length, true);
  bindEditor();
}

function plusHtml(index, last = false) {
  return `<div class="zap-plus ${last ? 'last' : ''}" data-index="${index}"><button title="Añadir un paso aquí" data-add="${index}">＋</button>${last ? '<span>Añadir un paso</span>' : ''}</div>`;
}

function badge(ok) {
  return ok ? '<span class="zap-check">✓</span>' : '';
}

function cardHtml(c, i) {
  const m = c.module ? modByKey(c.module) : null;
  const def = eventDef(c);
  const isOpen = open.card === c.id;
  const done = isComplete(c);
  const run = runOf(c.id);
  const title = m ? `${i + 1}. ${m.name}` : c.kind === 'trigger' ? '1. Elige qué inicia el flujo' : `${i + 1}. Elige una acción`;
  return `<div class="zap-card ${isOpen ? 'open' : ''} ${c.kind}" data-card="${esc(c.id)}" ${c.kind === 'action' ? 'draggable="true"' : ''}>
    <div class="zap-head" data-toggle="${esc(c.id)}">
      ${c.kind === 'action' ? '<span class="zap-grip" title="Arrastra para reordenar">⋮⋮</span>' : ''}
      <span class="zap-ico ${m ? '' : 'empty'}">${m ? logo(m) : c.kind === 'trigger' ? ICON_BOLT : ICON_PLUS}${badge(done)}</span>
      <div class="zap-titles"><div class="zap-kind">${c.kind === 'trigger' ? 'Disparador' : 'Acción'}</div><div class="zap-title">${esc(title)}</div>${def ? `<div class="zap-sub">${esc(c.kind === 'action' && c.name && c.name !== def.name ? `${c.name} · ` : '')}${esc(def.name)}</div>` : ''}</div>
      ${run && c.kind === 'action' ? `<span class="node-status s-${esc(run.status)}">${STATUS[run.status] ?? ''} ${esc(run.status)}</span>` : ''}
      ${c.kind === 'action' ? `<button class="zap-more" data-del="${esc(c.id)}" title="Eliminar paso">🗑</button>` : ''}
    </div>
    ${isOpen ? bodyHtml(c, i) : ''}
  </div>`;
}

function sectionHead(key, label, ok) {
  const active = open.section === key;
  return `<button class="zap-sec ${active ? 'active' : ''}" data-section="${key}"><span class="chev">${active ? '⌃' : '⌄'}</span>${esc(label)}${ok ? '<span class="zap-ok">✓</span>' : '<span class="zap-pending"></span>'}</button>`;
}

function bodyHtml(c, i) {
  const def = eventDef(c);
  const run = runOf(c.id);
  const kindWord = c.kind === 'trigger' ? 'disparador' : 'acción';
  let html = '';
  // 1. Elegir app y evento
  html += sectionHead('app', 'Elegir app y evento', Boolean(def));
  if (open.section === 'app') html += `<div class="zap-sec-body">${appPickerHtml(c)}</div>`;
  // 2. Elegir conexión (solo si la app pide credenciales)
  const auth = c.module ? modByKey(c.module)?.auth : null;
  if (auth) {
    html += sectionHead('conn', 'Elegir conexión', isConnected(c.module));
    if (open.section === 'conn') html += `<div class="zap-sec-body">${connectionHtml(c)}</div>`;
  }
  // 3. Configurar
  html += sectionHead('setup', c.kind === 'trigger' ? 'Configurar disparador' : 'Configurar acción', Boolean(def) && !missingRequired(c).length);
  if (open.section === 'setup') {
    html += `<div class="zap-sec-body">${def ? setupHtml(c) : `<p class="muted">Primero elige la app y el ${kindWord}.</p>`}
      ${def ? `<button class="primary zap-continue" data-next="test">Continuar</button>` : ''}</div>`;
  }
  // 3. Probar
  html += sectionHead('test', c.kind === 'trigger' ? 'Probar disparador' : 'Probar acción', run?.status === 'ok');
  if (open.section === 'test') {
    html += `<div class="zap-sec-body">
      <p class="muted">${c.kind === 'trigger' ? 'Se ejecuta el flujo con los datos de prueba para ver qué datos produce el disparador.' : 'Se ejecuta el flujo completo con los datos de prueba y verás el resultado de este paso.'}</p>
      <button class="zap-test" data-test="1">▶ Probar ahora</button>
      ${run ? `<div class="zap-result"><b class="s-${esc(run.status)}">${STATUS[run.status] ?? ''} ${run.status === 'ok' ? 'Funciona' : esc(run.status)}</b>${run.ms !== undefined ? ` · ${run.ms} ms` : ''}<pre class="result">${esc(run.error ?? JSON.stringify(run.output ?? {}, null, 2))}</pre></div>` : ''}
      <button class="primary zap-continue" data-next="done">Continuar</button>
    </div>`;
  }
  return `<div class="zap-body">${html}</div>`;
}

function connectionHtml(c) {
  const m = modByKey(c.module);
  const saved = connections[m.key] ?? {};
  const ok = isConnected(m.key);
  return `
    ${ok ? `<div class="conn-ok">✓ ${esc(m.name)} conectado${Object.values(saved).length ? ` · ${esc(Object.values(saved).join(' · '))}` : ''}</div>` : `<p class="muted">Conecta tu cuenta de <b>${esc(m.name)}</b> una sola vez; servirá para todas tus automatizaciones.</p>`}
    ${m.auth.help ? `<p class="muted small">${esc(m.auth.help)}</p>` : ''}
    <div class="conn-form">
      ${m.auth.fields.map((f) => `<div class="zfield"><label class="zlabel" for="conn-${esc(f.key)}">${esc(f.label)}${f.optional ? '' : ' <b class="req">*</b>'}</label>
        <div class="zinput"><input id="conn-${esc(f.key)}" data-conn="${esc(f.key)}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" placeholder="${esc(saved[f.key] ? `${saved[f.key]} (déjalo vacío para no cambiarlo)` : f.placeholder ?? '')}" /></div>
        ${f.help ? `<small class="zhelp">${esc(f.help)}</small>` : ''}</div>`).join('')}
    </div>
    <div class="conn-actions">
      <button class="primary zap-continue" data-conn-save="1">${ok ? 'Guardar cambios' : `Conectar ${esc(m.name)}`}</button>
      ${ok ? '<button class="ghost" data-conn-del="1">Desconectar</button>' : ''}
      ${m.homepage ? `<a class="muted small" href="${esc(m.homepage)}" target="_blank" rel="noopener">¿Dónde consigo estos datos? ↗</a>` : ''}
    </div>
    <p class="muted small">Se guardan en tu servidor, en <code>data/connections.json</code> (solo tu usuario puede leer el archivo), y nunca se muestran completos.</p>`;
}

function appPickerHtml(c) {
  const list = modules.filter((m) => (c.kind === 'trigger' ? m.triggers.length : m.actions.length));
  const chosen = open.pickModule ?? c.module;
  const m = chosen ? modByKey(chosen) : null;
  const events = m ? (c.kind === 'trigger' ? m.triggers : m.actions) : [];
  const cats = [...new Set(list.map((x) => x.category))];
  return `
    <div class="field"><span>App <small class="muted">(${list.length} disponibles)</small></span>
      <div class="app-search-row"><input id="app-search" placeholder="Buscar entre ${list.length} apps: Slack, Notion, Stripe, Figma, MCP…" autocomplete="off" /></div>
      <div class="app-cats"><button class="app-cat active" data-cat="">Todas</button>${cats.map((k) => `<button class="app-cat" data-cat="${esc(k)}">${esc(k)}</button>`).join('')}</div>
      <div class="app-grid">${list.map((x) => `<button class="app-tile ${x.key === chosen ? 'sel' : ''}" data-pick="${esc(x.key)}" data-cat-of="${esc(x.category)}" data-search="${esc(`${x.name} ${x.description} ${x.category}`.toLowerCase())}" ><span>${logo(x)}</span><b>${esc(x.name)}</b>${x.badge === 'MCP' || x.badge === 'API' ? `<em class="tile-badge">${esc(x.badge)}</em>` : ''}${connections[x.key] ? '<i class="tile-ok" title="Conectado">✓</i>' : ''}</button>`).join('')}</div>
      <p class="muted small app-empty" hidden>No hay coincidencias. Prueba con el módulo <b>MCP</b> o <b>Cualquier API (OpenAPI)</b>: conectan con casi cualquier servicio.</p>
    </div>
    ${m ? `<div class="field"><span>${c.kind === 'trigger' ? 'Evento que inicia el flujo' : 'Qué debe hacer'}</span>
      <div class="event-list">${events.map((e) => `<button class="event ${c.module === m.key && c.key === e.key ? 'sel' : ''}" data-event="${esc(e.key)}"><b>${esc(e.name)}</b>${e.description ? `<small>${esc(e.description)}</small>` : ''}</button>`).join('')}</div></div>` : '<p class="muted small">Elige una app para ver sus opciones.</p>'}`;
}

// Etiquetas legibles para los datos: trigger.body.nombre → "Disparador › body › nombre"
function varLabel(path) {
  const parts = path.split('.');
  if (parts[0] === 'trigger') return ['Disparador', ...parts.slice(1)].join(' › ');
  if (parts[0] === 'steps') {
    const idx = flow.steps.findIndex((s) => s.id === parts[1]);
    return [`${idx + 2}. ${flow.steps[idx]?.name ?? parts[1]}`, ...parts.slice(2)].join(' › ');
  }
  return path;
}
// Vista previa del texto con los {{datos}} como etiquetas
function previewHtml(value) {
  if (typeof value !== 'string' || !value.includes('{{')) return '';
  return `<div class="var-preview">${esc(value).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, p) => `<span class="var-chip">${esc(varLabel(p))}</span>`)}</div>`;
}

function flatten(obj, prefix, out = [], depth = 0) {
  if (obj === null || obj === undefined || depth > 4) return out;
  if (typeof obj !== 'object') { out.push([prefix, obj]); return out; }
  const entries = Array.isArray(obj) ? obj.slice(0, 3).map((v, i) => [String(i), v]) : Object.entries(obj).slice(0, 40);
  for (const [k, v] of entries) flatten(v, `${prefix}.${k}`, out, depth + 1);
  return out;
}

function availableVars(cardId) {
  const groups = [];
  if (lastRun?.trigger) groups.push({ title: '1. Disparador', vars: flatten(lastRun.trigger, 'trigger') });
  const upto = cardId === 'trigger' ? -1 : flow.steps.findIndex((s) => s.id === cardId);
  flow.steps.slice(0, Math.max(0, upto)).forEach((s, i) => {
    const r = lastRun?.steps.find((x) => x.id === s.id);
    if (r?.status === 'ok' && r.output) {
      const out = r.output.resultado !== undefined && r.output.registro ? r.output.resultado : r.output;
      groups.push({ title: `${i + 2}. ${s.name || s.key}`, vars: flatten(out, `steps.${s.id}`) });
    }
  });
  return groups;
}

function fieldHtml(c, arg) {
  const v = c.args?.[arg.key] ?? '';
  const id = `f-${c.id}-${arg.key}`;
  const common = `id="${id}" data-arg="${esc(arg.key)}" placeholder="${esc(arg.placeholder ?? '')}"`;
  let input;
  if (arg.type === 'text' || arg.type === 'json') input = `<textarea ${common} rows="${arg.type === 'json' ? 4 : 3}">${esc(typeof v === 'object' ? JSON.stringify(v, null, 2) : v)}</textarea>`;
  else if (arg.type === 'dropdown') input = `<select ${common}>${(arg.options ?? []).map((o) => `<option value="${esc(o.value)}" ${String(v) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  else if (arg.type === 'agent') input = `<select ${common}><option value="">${arg.required ? 'Elige un agente…' : 'Cualquier agente'}</option>${agents.map((a) => `<option value="${esc(a.id)}" ${v === a.id ? 'selected' : ''}>${esc(a.icon ?? '🤖')} ${esc(a.name)}</option>`).join('')}</select>`;
  else if (arg.type === 'boolean') input = `<label class="chk"><input type="checkbox" ${common} ${v ? 'checked' : ''}/> Sí</label>`;
  else input = `<input ${common} value="${esc(v)}" />`;
  const canVars = arg.variables && arg.type !== 'dropdown' && arg.type !== 'agent' && arg.type !== 'boolean';
  return `<div class="zfield">
    <label for="${id}" class="zlabel">${esc(arg.label)}${arg.required ? ' <b class="req">*</b>' : ''}</label>
    <div class="zinput">${input}${canVars ? `<button class="add-var" data-varfor="${esc(arg.key)}" title="Insertar un dato de un paso anterior">＋ dato</button>` : ''}</div>
    ${varMenuFor === `${c.id}:${arg.key}` ? varMenuHtml(c) : ''}
    ${previewHtml(v)}
    ${arg.description ? `<small class="zhelp">${esc(arg.description)}</small>` : ''}
  </div>`;
}

function varMenuHtml(c) {
  const groups = availableVars(c.id);
  if (!groups.length) return `<div class="var-menu"><p class="muted small">Todavía no hay datos. Prueba el disparador (o los pasos anteriores) para poder usarlos aquí.</p></div>`;
  return `<div class="var-menu">${groups.map((g) => `<div class="vm-group"><div class="vm-title">${esc(g.title)}</div>${g.vars.map(([p, val]) => `<button class="vm-item" data-insert="${esc(p)}"><span>${esc(p.split('.').slice(c.id === 'trigger' ? 1 : p.startsWith('steps') ? 2 : 1).join(' › '))}</span><small>${esc(String(val)).slice(0, 50)}</small></button>`).join('')}</div>`).join('')}</div>`;
}

function setupHtml(c) {
  const def = eventDef(c);
  const args = def.arguments ?? [];
  const hook = c.kind === 'trigger' && def.type === 'webhook'
    ? `<div class="zfield"><span class="zlabel">URL para recibir datos</span><div class="copy-row"><code id="hook-url">${esc(`${location.origin}/hooks/${flow.id ?? '…'}${c.args?.secret ? `?token=${encodeURIComponent(c.args.secret)}` : ''}`)}</code><button id="copy-hook">Copiar</button></div><small class="zhelp">Envía aquí un POST con JSON. Funciona cuando el flujo está publicado.</small></div>` : '';
  const test = c.kind === 'trigger' && ['webhook', 'manual', 'event'].includes(def.type)
    ? `<div class="zfield"><label class="zlabel" for="test-payload">Datos de ejemplo para probar</label><textarea id="test-payload" rows="5">${esc(JSON.stringify(flow.testPayload ?? {}, null, 2))}</textarea><small class="zhelp">Simulan lo que llegará de verdad. Se usan al pulsar "Probar".</small></div>` : '';
  const name = c.kind === 'action' ? `<div class="zfield"><label class="zlabel" for="step-name">Nombre del paso</label><div class="zinput"><input id="step-name" value="${esc(c.name ?? '')}" /></div></div>` : '';
  return `${def.description ? `<p class="muted small">${esc(def.description)}</p>` : ''}${name}${args.map((a) => fieldHtml(c, a)).join('')}${hook}${test}${!args.length && !hook && !test ? '<p class="muted">Este paso no necesita configuración.</p>' : ''}`;
}

// ---------- eventos del editor ----------

const SAMPLE = {
  webhook: { body: { nombre: 'Ana', mensaje: 'Hola, ¿tienen envío gratis?' } },
  event: { agentId: 'soporte-al-cliente', agentName: 'Soporte al cliente', message: 'quiero hablar con una persona', reply: 'Te paso con el equipo', topic: 'Hablar con una persona' },
  manual: {},
};

function bindEditor() {
  $$('#zap [data-toggle]').forEach((h) => (h.onclick = (e) => {
    if (e.target.closest('[data-del]')) return;
    const id = h.dataset.toggle;
    if (open.card === id) open.card = null;
    else {
      const c = cards().find((x) => x.id === id);
      open = { card: id, section: c?.module ? 'setup' : 'app', pickModule: null };
    }
    varMenuFor = null;
    renderEditor();
  }));
  $$('#zap [data-section]').forEach((b) => (b.onclick = () => { open.section = b.dataset.section; varMenuFor = null; renderEditor(); }));
  $$('#zap [data-add]').forEach((b) => (b.onclick = () => {
    const step = { id: uid(), module: undefined, key: undefined, name: '', args: {} };
    flow.steps.splice(Number(b.dataset.add), 0, step);
    open = { card: step.id, section: 'app', pickModule: null };
    renderEditor();
    $(`[data-card="${step.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  $$('#zap [data-del]').forEach((b) => (b.onclick = () => {
    if (!confirm('¿Eliminar este paso?')) return;
    flow.steps = flow.steps.filter((s) => s.id !== b.dataset.del);
    changed();
    renderEditor();
  }));
  $$('#zap [data-pick]').forEach((b) => (b.onclick = () => { open.pickModule = b.dataset.pick; renderEditor(); $('#zap .event-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }));
  // Filtrar apps al escribir o al elegir categoría, sin redibujar (no se pierde el foco)
  let cat = '';
  const filterApps = () => {
    const q = ($('#app-search')?.value ?? '').trim().toLowerCase();
    let shown = 0;
    $$('#zap .app-tile').forEach((tile) => {
      const ok = (!cat || tile.dataset.catOf === cat) && (!q || tile.dataset.search.includes(q));
      tile.hidden = !ok;
      if (ok) shown++;
    });
    const empty = $('#zap .app-empty');
    if (empty) empty.hidden = shown > 0;
  };
  $('#app-search')?.addEventListener('input', filterApps);
  $$('#zap [data-cat]').forEach((b) => (b.onclick = () => {
    cat = b.dataset.cat;
    $$('#zap [data-cat]').forEach((x) => x.classList.toggle('active', x === b));
    filterApps();
  }));
  $('#zap [data-conn-save]')?.addEventListener('click', async () => {
    const app = cardRef(open.card).module;
    const values = Object.fromEntries($$('#zap [data-conn]').map((el) => [el.dataset.conn, el.value]));
    try {
      await api(`/api/connections/${app}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
      connections = await api('/api/connections');
      if (isConnected(app)) open.section = 'setup';
      renderEditor();
    } catch (e) {
      alert(e.message);
    }
  });
  $('#zap [data-conn-del]')?.addEventListener('click', async () => {
    const app = cardRef(open.card).module;
    if (!confirm('¿Desconectar esta app? Las automatizaciones que la usen dejarán de funcionar.')) return;
    await api(`/api/connections/${app}`, { method: 'DELETE' });
    connections = await api('/api/connections');
    renderEditor();
  });
  $$('#zap [data-event]').forEach((b) => (b.onclick = () => {
    const ref = cardRef(open.card);
    const mod = modByKey(open.pickModule ?? ref.module);
    const isTrigger = open.card === 'trigger';
    const def = (isTrigger ? mod.triggers : mod.actions).find((x) => x.key === b.dataset.event);
    const same = ref.module === mod.key && ref.key === def.key;
    ref.module = mod.key;
    ref.key = def.key;
    if (!same) ref.args = Object.fromEntries((def.arguments ?? []).filter((a) => a.default !== undefined).map((a) => [a.key, a.default]));
    if (!isTrigger && (!ref.name || !same)) ref.name = def.name;
    if (isTrigger && SAMPLE[def.type] && (!same || flow.testPayload === undefined)) flow.testPayload = SAMPLE[def.type];
    open.section = isConnected(mod.key) ? 'setup' : 'conn';
    open.pickModule = null;
    changed();
    renderEditor();
  }));
  const ref = open.card ? cardRef(open.card) : null;
  $$('#zap [data-arg]').forEach((el) => {
    const update = () => {
      ref.args = { ...(ref.args ?? {}), [el.dataset.arg]: el.type === 'checkbox' ? el.checked : el.value };
      changed();
      // Actualiza la vista previa de etiquetas y los checks sin perder el foco
      const box = el.closest('.zfield');
      box.querySelector('.var-preview')?.remove();
      const pv = previewHtml(el.value);
      if (pv) box.querySelector('.zinput').insertAdjacentHTML('afterend', pv);
      if (el.dataset.arg === 'secret' && $('#hook-url')) $('#hook-url').textContent = `${location.origin}/hooks/${flow.id ?? '…'}${el.value ? `?token=${encodeURIComponent(el.value)}` : ''}`;
    };
    // Recordar dónde estaba el cursor para insertar ahí los datos
    const remember = () => { if (typeof el.selectionStart === 'number') caret = { key: el.dataset.arg, pos: el.selectionStart }; };
    ['keyup', 'click', 'select', 'input'].forEach((ev) => el.addEventListener(ev, remember));
    el.addEventListener('input', update);
    el.addEventListener('change', () => { update(); if (el.tagName === 'SELECT' || el.type === 'checkbox') renderEditor(); });
  });
  $('#step-name')?.addEventListener('input', (e) => { ref.name = e.target.value; changed(); });
  $('#test-payload')?.addEventListener('input', (e) => {
    try { flow.testPayload = JSON.parse(e.target.value); e.target.classList.remove('bad'); changed(); } catch { e.target.classList.add('bad'); }
  });
  $('#copy-hook')?.addEventListener('click', () => navigator.clipboard.writeText($('#hook-url').textContent));
  $$('#zap [data-varfor]').forEach((b) => (b.onclick = () => {
    const key = `${open.card}:${b.dataset.varfor}`;
    varMenuFor = varMenuFor === key ? null : key;
    renderEditor();
  }));
  $$('#zap [data-insert]').forEach((b) => (b.onclick = () => {
    const argKey = varMenuFor.split(':')[1];
    const el = $(`#zap [data-arg="${argKey}"]`);
    const token = `{{${b.dataset.insert}}}`;
    // En la posición del cursor si el usuario estaba escribiendo en este campo; si no, al final
    const start = caret.key === argKey && caret.pos !== null ? Math.min(caret.pos, el.value.length) : el.value.length;
    el.value = el.value.slice(0, start) + token + el.value.slice(start);
    caret = { key: argKey, pos: start + token.length };
    ref.args = { ...(ref.args ?? {}), [argKey]: el.value };
    varMenuFor = null;
    changed();
    renderEditor();
  }));
  $$('#zap [data-next]').forEach((b) => (b.onclick = async () => {
    if (b.dataset.next === 'test') { open.section = 'test'; return renderEditor(); }
    // Pasar a la siguiente tarjeta incompleta o cerrar
    const list = cards();
    const idx = list.findIndex((c) => c.id === open.card);
    const next = list.slice(idx + 1).find((c) => !isComplete(c));
    open = next ? { card: next.id, section: next.module ? 'setup' : 'app', pickModule: null } : { card: null, section: 'app', pickModule: null };
    await save();
    renderEditor();
  }));
  $$('#zap [data-test]').forEach((b) => (b.onclick = async () => {
    if (!flow.trigger?.module) return alert('Primero elige el disparador.');
    b.disabled = true;
    b.textContent = 'Probando…';
    await save();
    lastRun = await post(`/api/flows/${flow.id}/run`, { payload: flow.testPayload });
    renderEditor();
  }));

  // Reordenar pasos arrastrando la tarjeta y soltando sobre un "+"
  $$('#zap .zap-card.action').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.card);
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('zap-dragging');
    });
    card.addEventListener('dragend', () => document.body.classList.remove('zap-dragging'));
  });
  $$('#zap .zap-plus').forEach((z) => {
    z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('zap-dragging');
      const id = e.dataTransfer.getData('text/plain');
      const from = flow.steps.findIndex((s) => s.id === id);
      if (from < 0) return;
      let to = Number(z.dataset.index);
      const [s] = flow.steps.splice(from, 1);
      if (from < to) to--;
      flow.steps.splice(to, 0, s);
      changed();
      renderEditor();
    });
  });
}

// ---------- integración con el asistente y el onboarding ----------

export async function openFlowById(id) {
  await loadMeta();
  openFlow(await api(`/api/flows/${id}`));
}
export function getCurrentFlowId() {
  return flow?.id ?? null;
}
// Si el asistente cambió el flujo que está abierto, recargarlo
export async function refreshIfOpen(id) {
  if (flow?.id === id && !$('#flows-editor').hidden) {
    await loadMeta();
    const f = await api(`/api/flows/${id}`);
    flow = f;
    renderEditor();
  }
}

// ---------- marketplace de apps (inspirado en el de Dify) ----------

const KIND_TABS = [
  { k: '', label: 'Todas' },
  { k: 'app', label: 'Apps nativas' },
  { k: 'api', label: 'APIs' },
  { k: 'mcp', label: 'Servidores MCP' },
  { k: 'basico', label: 'Herramientas' },
  { k: 'comunidad', label: 'Comunidad' },
];
const KIND_LABEL = { app: 'App nativa', api: 'API REST', mcp: 'MCP', basico: 'Herramienta', comunidad: 'Comunidad' };
const mk = { kind: '', cat: '', q: '', sort: 'pop' };

function mkCard(m) {
  const n = m.actions.length + m.triggers.length;
  return `<button class="mk-card" data-mk="${esc(m.key)}" data-kind="${kindOf(m)}" data-cat="${esc(m.category)}" data-search="${esc(`${m.name} ${m.description} ${m.category} ${m.key}`.toLowerCase())}">
    <div class="mk-card-top"><span class="mk-logo">${logo(m)}</span>
      <div class="mk-card-titles"><b>${esc(m.name)}</b><small>${esc(m.author || 'Agent Studio')} · ${esc(KIND_LABEL[kindOf(m)])}</small></div>
      ${connections[m.key] ? '<span class="mk-conn" title="Conectado">✓</span>' : ''}</div>
    <p>${esc(m.description || 'Sin descripción.')}</p>
    <div class="mk-tags"><span>${esc(m.category)}</span><span>${n} ${n === 1 ? 'acción' : 'acciones'}</span>${m.triggers.length ? '<span>disparador</span>' : ''}</div>
  </button>`;
}

function mkFilter() {
  const q = mk.q.trim().toLowerCase();
  let shown = 0;
  $$('#modules-grid .mk-card').forEach((c) => {
    const ok = (!mk.kind || c.dataset.kind === mk.kind) && (!mk.cat || c.dataset.cat === mk.cat) && (!q || c.dataset.search.includes(q));
    c.hidden = !ok;
    if (ok) shown++;
  });
  $('#mk-result').textContent = `${shown} ${shown === 1 ? 'app' : 'apps'}${mk.cat ? ` en ${mk.cat}` : ''}`;
  $('#mk-empty').hidden = shown > 0;
}

function mkRender(list) {
  const pool = list.filter((m) => !mk.kind || kindOf(m) === mk.kind);
  const counts = {};
  for (const m of pool) counts[m.category] = (counts[m.category] ?? 0) + 1;
  const cats = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  $('#mk-tabs').innerHTML = KIND_TABS.map((t) => {
    const n = t.k ? list.filter((m) => kindOf(m) === t.k).length : list.length;
    return n || !t.k ? `<button class="mk-tab ${mk.kind === t.k ? 'active' : ''}" data-kind-tab="${t.k}">${esc(t.label)} <small>${n}</small></button>` : '';
  }).join('');
  $('#mk-cats').innerHTML = `<div class="mk-side-title">Categorías</div><button class="mk-cat ${!mk.cat ? 'active' : ''}" data-mk-cat="">Todas <small>${pool.length}</small></button>`
    + cats.map(([c, n]) => `<button class="mk-cat ${mk.cat === c ? 'active' : ''}" data-mk-cat="${esc(c)}">${esc(c)} <small>${n}</small></button>`).join('');
  const sorted = [...list].sort(mk.sort === 'az' ? (a, b) => a.name.localeCompare(b.name, 'es') : mk.sort === 'ops' ? (a, b) => (b.actions.length + b.triggers.length) - (a.actions.length + a.triggers.length) : byRank);
  $('#modules-grid').innerHTML = sorted.map(mkCard).join('');
  $$('[data-kind-tab]').forEach((b) => (b.onclick = () => { mk.kind = b.dataset.kindTab; mk.cat = ''; mkRender(list); }));
  $$('[data-mk-cat]').forEach((b) => (b.onclick = () => { mk.cat = b.dataset.mkCat; $$('[data-mk-cat]').forEach((x) => x.classList.toggle('active', x === b)); mkFilter(); }));
  $$('#modules-grid .mk-card').forEach((c) => (c.onclick = () => mkDetail(modByKey(c.dataset.mk))));
  mkFilter();
}

function mkDetail(m) {
  const el = $('#mk-detail');
  const ok = Boolean(connections[m.key]);
  const saved = connections[m.key] ?? {};
  el.innerHTML = `<div class="mk-detail-back" data-mk-close></div>
    <aside class="mk-panel" role="dialog" aria-label="${esc(m.name)}">
      <button class="mk-x" data-mk-close aria-label="Cerrar">✕</button>
      <div class="mk-panel-head"><span class="mk-logo big">${logo(m)}</span><div><h2>${esc(m.name)}</h2>
        <div class="mk-tags"><span class="kind-${kindOf(m)}">${esc(KIND_LABEL[kindOf(m)])}</span><span>${esc(m.category)}</span>${ok ? '<span class="on">Conectado</span>' : ''}</div></div></div>
      <p>${esc(m.description)}</p>
      <div class="mk-panel-actions">
        <button class="primary" data-mk-use>Usar en una automatización</button>
        ${m.homepage ? `<a class="ghost-link" href="${esc(m.homepage)}" target="_blank" rel="noopener">Documentación ↗</a>` : ''}
        ${m.source === 'comunidad' ? `<button class="danger" data-uninstall="${esc(m.key)}">Desinstalar</button>` : ''}
      </div>
      ${m.auth ? `<section class="mk-sec"><h3>Conexión</h3>
        ${m.auth.help ? `<p class="muted small">${esc(m.auth.help)}</p>` : ''}
        ${m.auth.fields.map((f) => `<div class="zfield"><label class="zlabel" for="mkc-${esc(f.key)}">${esc(f.label)}${f.optional ? '' : ' <b class="req">*</b>'}</label>
          <div class="zinput"><input id="mkc-${esc(f.key)}" data-mk-conn="${esc(f.key)}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" placeholder="${esc(saved[f.key] ? `${saved[f.key]} (vacío = sin cambios)` : f.placeholder ?? '')}" /></div>
          ${f.help ? `<small class="zhelp">${esc(f.help)}</small>` : ''}</div>`).join('')}
        <div class="conn-actions"><button class="primary" data-mk-save>${ok ? 'Guardar cambios' : 'Conectar'}</button>${ok ? '<button class="ghost" data-mk-disc>Desconectar</button>' : ''}<span class="muted small" id="mk-conn-msg"></span></div>
        <p class="muted small">Se guardan en tu servidor (<code>data/connections.json</code>, sin cifrar, solo legible por tu usuario).</p>
      </section>` : ''}
      ${m.triggers.length ? `<section class="mk-sec"><h3>Disparadores <small>${m.triggers.length}</small></h3><ul class="mk-ops">${m.triggers.map((t) => `<li><b>${esc(t.name)}</b>${t.description ? `<small>${esc(t.description)}</small>` : ''}</li>`).join('')}</ul></section>` : ''}
      <section class="mk-sec"><h3>Acciones <small>${m.actions.length}</small></h3><ul class="mk-ops">${m.actions.map((a) => `<li data-mk-act="${esc(a.key)}"><b>${esc(a.name)}</b>${a.description ? `<small>${esc(a.description)}</small>` : ''}</li>`).join('') || '<li class="muted">—</li>'}</ul></section>
      <p class="muted small">${esc(m.author ? `Fuente: ${m.author}` : '')}${m.version ? ` · v${esc(m.version)}` : ''} · clave <code>${esc(m.key)}</code></p>
    </aside>`;
  el.hidden = false;
  const close = () => { el.hidden = true; el.innerHTML = ''; };
  $$('[data-mk-close]', el).forEach((b) => (b.onclick = close));
  el.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  $('.mk-x', el).focus();
  const use = async (actKey) => {
    const act = m.actions.find((a) => a.key === actKey) ?? m.actions[0];
    const trig = m.triggers[0];
    const body = act
      ? { name: `Automatización con ${m.name}`, active: false, trigger: { module: 'core', key: 'manual', args: {} }, steps: [{ id: 'paso1', module: m.key, key: act.key, name: act.name, args: {} }] }
      : { name: `Automatización con ${m.name}`, active: false, trigger: { module: m.key, key: trig.key, args: {} }, steps: [] };
    const f = await post('/api/flows', body);
    close();
    document.dispatchEvent(new CustomEvent('as:open-flow', { detail: f.id }));
  };
  $('[data-mk-use]', el).onclick = () => use();
  $$('[data-mk-act]', el).forEach((li) => { li.title = 'Crear una automatización con esta acción'; li.onclick = () => use(li.dataset.mkAct); });
  $('[data-mk-save]', el)?.addEventListener('click', async () => {
    const values = Object.fromEntries($$('[data-mk-conn]', el).map((i) => [i.dataset.mkConn, i.value]));
    try {
      await api(`/api/connections/${m.key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
      connections = await api('/api/connections');
      mkDetail(m);
      mkRender(modules);
    } catch (e) { $('#mk-conn-msg').textContent = `✖ ${e.message}`; }
  });
  $('[data-mk-disc]', el)?.addEventListener('click', async () => {
    if (!confirm(`¿Desconectar ${m.name}? Las automatizaciones que la usen dejarán de funcionar.`)) return;
    await api(`/api/connections/${m.key}`, { method: 'DELETE' });
    connections = await api('/api/connections');
    mkDetail(m);
    mkRender(modules);
  });
  $('[data-uninstall]', el)?.addEventListener('click', async () => {
    if (!confirm(`¿Desinstalar el módulo "${m.key}"? Los flujos que lo usen dejarán de funcionar.`)) return;
    await api(`/api/modules/${m.key}`, { method: 'DELETE' });
    close();
    loadModulesView();
  });
}

export async function loadModulesView() {
  const [{ modules: list, errors }, conns] = await Promise.all([api('/api/modules'), api('/api/connections')]);
  modules = list.sort(byRank);
  connections = conns;
  $('#mk-count').textContent = list.length;
  $('#mod-search').value = mk.q;
  $('#mod-search').oninput = (e) => { mk.q = e.target.value; mkFilter(); };
  $('#mk-sort').value = mk.sort;
  $('#mk-sort').onchange = (e) => { mk.sort = e.target.value; mkRender(modules); };
  $('#modules-errors').innerHTML = errors.length ? `<div class="m-banner warn-banner">⚠ ${errors.map((e) => `${esc(e.dir.split('/').slice(-2).join('/'))}: ${esc(e.error)}`).join('<br>')}</div>` : '';
  mkRender(modules);
}

// ---------- arranque ----------

export function initFlows(apiFn, postFn) {
  api = apiFn;
  post = postFn;
  $('#flow-new').onclick = () => openFlow({ name: 'Nueva automatización', active: false, trigger: null, steps: [] });
  $('#flow-back').onclick = async () => {
    if (saveTimer) await save();
    flow = null;
    loadFlowsView();
  };
  $('#flow-name').oninput = changed;
  $('#flow-publish').onclick = async () => {
    if (!flow.active) {
      const incomplete = cards().filter((c) => !isComplete(c));
      if (incomplete.length) return alert(`Completa primero: ${incomplete.map((c) => (c.kind === 'trigger' ? 'el disparador' : `el paso "${c.name || 'sin elegir'}"`)).join(', ')}.`);
      if (!flow.steps.length) return alert('Añade al menos una acción.');
    }
    flow.active = !flow.active;
    await save();
  };
  $('#flow-delete').onclick = async () => {
    if (!flow.id || !confirm(`¿Eliminar "${flow.name}"?`)) return;
    await api(`/api/flows/${flow.id}`, { method: 'DELETE' });
    flow = null;
    loadFlowsView();
  };
  $('#mod-reload').onclick = async () => { await api('/api/modules/reload', { method: 'POST' }); loadModulesView(); };
  $('#mod-install').onclick = async () => {
    const url = $('#mod-url').value.trim();
    if (!url) return;
    if (!confirm('Un módulo ejecuta código en tu servidor. Instala solo módulos de fuentes de confianza. ¿Continuar?')) return;
    $('#mod-msg').textContent = 'Instalando…';
    try {
      const r = await post('/api/modules/install', { url });
      $('#mod-msg').textContent = `✔ Instalado: ${r.name}`;
      $('#mod-url').value = '';
      loadModulesView();
    } catch (e) {
      $('#mod-msg').textContent = `✖ ${e.message}`;
    }
  };
}
