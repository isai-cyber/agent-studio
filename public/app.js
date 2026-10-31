import { initMetrics, load as loadMetrics } from './metrics.js';
import { initFlows, loadFlowsView, loadModulesView, openFlowById, openAppDetail, setTenantSlug } from './flows.js';
import { initAssistant } from './assistant.js';
import { ensureAuth, sessionExpired } from './auth.js';
import { ctx, loadContext, can, isPlatformAdmin } from './context.js';
import { initSettings, loadSettingsView } from './settings.js';
import { initPlatform, loadPlatformView } from './admin.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : type.startsWith('audio') ? await res.blob() : await res.text();
  if (res.status === 401 && !path.startsWith('/api/auth/')) sessionExpired();
  // El error lleva el cuerpo (p. ej. qué dependencias faltan al activar un módulo)
  if (!res.ok) throw Object.assign(new Error(body?.error ?? body ?? res.statusText), { status: res.status, body });
  return body;
}
const post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });

let current = null; // agente abierto
let sessionId = null;
let status = {};

// ---------- navegación ----------
function show(view, sub) {
  if (ctx && !ctx.tenant && view !== 'notenant') view = 'notenant';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.rail nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'home') loadHome();
  if (view === 'agents') loadAgents();
  if (view === 'catalog') loadCatalog();
  if (view === 'connect') loadConnect();
  if (view === 'metrics') loadMetrics(api);
  if (view === 'flows') loadFlowsView();
  if (view === 'modules') loadModulesView();
  if (view === 'settings') loadSettingsView(sub);
  if (view === 'platform') loadPlatformView(sub);
}

// ---------- empresa activa, menú según permisos y módulos ----------
// (solo es interfaz: el servidor valida siempre)
const NAV_PERMS = {
  home: () => true,
  agents: () => can('agents.read'),
  catalog: () => can('agents.manage'),
  import: () => can('agents.manage'),
  flows: () => can('flows.read'),
  modules: () => can('flows.read'),
  metrics: () => can('metrics.read'),
  connect: () => can('agents.read'),
  settings: () => Boolean(ctx?.tenant),
  platform: () => isPlatformAdmin() && !ctx?.local,
};

function renderTenantBar() {
  const bar = $('#tenant-bar');
  if (!ctx?.tenant || ctx.local) { bar.hidden = true; return; }
  const many = ctx.tenants.length > 1;
  bar.hidden = false;
  bar.innerHTML = `${ctx.support ? `<span class="support-badge">🛟 Modo soporte en <b>${esc(ctx.tenant.name)}</b> (queda en su auditoría)</span><button class="ghost" id="support-exit">Salir del modo soporte</button>` : ''}
    <label class="tenant-pick" title="Empresa activa">🏢 ${many && !ctx.support
      ? `<select id="tenant-select" aria-label="Empresa activa">${ctx.tenants.map((t) => `<option value="${t.tenantId}" ${t.tenantId === ctx.tenant.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
      : `<b>${esc(ctx.tenant.name)}</b>`}
    <span class="pill-sm">${esc(ctx.role?.name ?? '')}</span></label>`;
  $('#tenant-select')?.addEventListener('change', async (e) => {
    await post('/api/me/tenant', { tenantId: Number(e.target.value) });
    location.reload();
  });
  $('#support-exit')?.addEventListener('click', async () => {
    await post('/api/platform/support/exit');
    location.reload();
  });
}

function applyContext() {
  for (const b of $$('.rail nav button')) b.hidden = !(NAV_PERMS[b.dataset.view] ?? (() => true))();
  $('#new-agent').hidden = !can('agents.manage');
  $('#delete-agent').hidden = !can('agents.manage');
  $('#save-yaml').hidden = !can('agents.manage');
  $('#flow-new').hidden = !can('flows.manage');
  $('#quick-form').hidden = !can('agents.manage');
  $('#asst-fab').hidden = !can('flows.manage');
  renderTenantBar();
}

export async function refreshContext() {
  await loadContext(api);
  setTenantSlug(ctx?.tenant?.slug);
  applyContext();
}
$$('.rail nav button').forEach((b) => (b.onclick = () => show(b.dataset.view)));
// El marketplace crea una automatización con una app y la abre en el editor
document.addEventListener('as:open-flow', async (e) => {
  show('flows');
  await openFlowById(e.detail);
});
$('#back').onclick = () => show('home');

$$('.tabs button').forEach(
  (b) =>
    (b.onclick = () => {
      $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
      if (b.dataset.tab === 'editor') loadYaml();
    }),
);

async function loadStatus() {
  status = await api('/api/status');
  const cc = status.claudeCode;
  const brain =
    status.backend === 'claude-code'
      ? `Backend: Claude Code ${cc?.apiKey ? '✅' : '⚠️ sin credenciales detectadas'}<br>Modelo: ${esc(cc?.model)}`
      : `Backend: directo<br>LLM: ${status.llm ? '✅' : '❌'} ${esc(status.model)}${status.llmRoutes ? `<br>Clasificar: ${esc(status.llmRoutes.classify)}<br>Proveedores: ${status.llmRoutes.providers.filter((p) => p.configured).map((p) => esc(p.name)).join(', ') || 'ninguno en .env'}` : ''}`;
  $('#status').innerHTML = `${brain}<br>Voz ElevenLabs: ${status.voice ? '✅' : '❌'}`;
  $('#sync-claude-code').hidden = status.backend !== 'claude-code';
  const ok = status.backend === 'claude-code' ? cc?.apiKey : status.llm;
  $('.rail-status').classList.toggle('warn', !ok);
  $('#speak').disabled = !status.voice;
  $('#mic').disabled = !status.voice;
}

// ---------- agentes ----------
function card(a, extra = '') {
  const cat = a.category ?? {};
  return `<div class="card agent-card" data-id="${esc(a.id)}">
    <div class="icon">${esc(a.icon ?? '🤖')}</div>
    <div class="name">${esc(a.name)}</div>
    <div class="muted">${esc(a.description ?? '')}</div>
    <div>${[cat.function, cat.industry, cat.useCase].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
    ${a.source === 'copilot-studio-import' ? '<span class="tag">Importado</span>' : ''}</div>
    ${extra}
  </div>`;
}

async function loadAgents() {
  const agents = await api('/api/agents');
  $('#agents-grid').innerHTML = agents.length
    ? agents.map((a) => card(a)).join('')
    : '<p class="muted">Aún no tienes agentes. Crea uno, usa una plantilla de la biblioteca o importa desde Copilot Studio.</p>';
  $$('#agents-grid .agent-card').forEach((c) => (c.onclick = () => openAgent(c.dataset.id)));
}

$('#new-agent').onclick = async () => {
  const name = prompt('Nombre del agente');
  if (!name) return;
  const a = await post('/api/agents', { name, instructions: `Eres ${name}, un asistente útil.`, icon: '🤖' });
  openAgent(a.id, 'editor');
};

async function openAgent(id, tab = 'chat') {
  current = await api(`/api/agents/${id}`);
  sessionId = null;
  $('#agent-title').textContent = `${current.icon ?? '🤖'} ${current.name}`;
  $('#messages').innerHTML = '';
  $('#options').innerHTML = '';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-agent'));
  $$('.tabs button').find((b) => b.dataset.tab === tab).click();
  $('#speak').checked = status.voice && current.voice?.enabled !== false;
  send(''); // saludo inicial
}

$('#delete-agent').onclick = async () => {
  if (!current || !confirm(`¿Eliminar "${current.name}"?`)) return;
  await api(`/api/agents/${current.id}`, { method: 'DELETE' });
  show('agents');
};

// ---------- chat ----------
function addMsg(role, text, meta = '') {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `${esc(text)}${meta ? `<div class="meta">${esc(meta)}</div>` : ''}`;
  $('#messages').append(div);
  $('#messages').scrollTop = 1e9;
}

let audio = null;
async function speak(text) {
  if (!$('#speak').checked || !text) return;
  try {
    const blob = await post('/api/tts', { text, agentId: current.id });
    audio?.pause();
    audio = new Audio(URL.createObjectURL(blob));
    await audio.play();
  } catch (e) {
    addMsg('bot error', `Voz: ${e.message}`);
  }
}

async function send(text) {
  if (text) addMsg('user', text);
  $('#options').innerHTML = '';
  try {
    const r = await post(`/api/agents/${current.id}/chat`, { message: text, sessionId });
    sessionId = r.sessionId;
    r.messages.forEach((m, i) => {
      const meta = i === r.messages.length - 1 ? [r.topic && `Tema: ${r.topic}`, r.sources?.length && `Fuentes: ${r.sources.join(', ')}`].filter(Boolean).join(' · ') : '';
      addMsg('bot', m, meta);
    });
    $('#options').innerHTML = (r.options ?? []).map((o) => `<button class="chip">${esc(o)}</button>`).join('');
    $$('#options .chip').forEach((b) => (b.onclick = () => send(b.textContent)));
    speak(r.messages.join('\n'));
  } catch (e) {
    addMsg('bot error', e.message);
  }
}

$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#chat-input').value.trim();
  if (!t) return;
  $('#chat-input').value = '';
  send(t);
};

$('#reset').onclick = async () => {
  if (sessionId) await api(`/api/sessions/${sessionId}/reset`, { method: 'POST' });
  sessionId = null;
  $('#messages').innerHTML = '';
  send('');
};

// Micrófono → ElevenLabs Scribe
let recorder = null;
$('#mic').onclick = async () => {
  if (recorder?.state === 'recording') return recorder.stop();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      $('#mic').classList.remove('recording');
      const blob = new Blob(chunks, { type: recorder.mimeType });
      try {
        const { text } = await api('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        if (text.trim()) send(text.trim());
      } catch (e) {
        addMsg('bot error', `Micrófono: ${e.message}`);
      }
    };
    recorder.start();
    $('#mic').classList.add('recording');
  } catch (e) {
    addMsg('bot error', `No hay acceso al micrófono: ${e.message}`);
  }
};

// ---------- editor ----------
async function loadYaml() {
  $('#yaml').value = await api(`/api/agents/${current.id}/yaml`);
  $('#save-msg').textContent = '';
}
$('#save-yaml').onclick = async () => {
  try {
    current = await api(`/api/agents/${current.id}/yaml`, { method: 'PUT', headers: { 'Content-Type': 'text/yaml' }, body: $('#yaml').value });
    $('#agent-title').textContent = `${current.icon ?? '🤖'} ${current.name}`;
    $('#save-msg').textContent = '✔ Guardado';
    sessionId = null;
  } catch (e) {
    $('#save-msg').textContent = `✖ ${e.message}`;
  }
};
$('#sync-claude-code').onclick = async () => {
  $('#save-msg').textContent = 'Regenerando CLAUDE.md…';
  try {
    const r = await post(`/api/agents/${current.id}/claude-code/sync`);
    $('#save-msg').textContent = `✔ ${r.changed ? 'Actualizado' : 'Ya estaba al día'}: ${r.file}`;
  } catch (e) {
    $('#save-msg').textContent = `✖ ${e.message}`;
  }
};
$('#load-voices').onclick = async () => {
  try {
    const voices = await api('/api/voices');
    $('#voices').textContent = 'Copia un voice_id en voice.voiceId:\n\n' + voices.map((v) => `${v.voice_id}  ${v.name}  ${Object.values(v.labels ?? {}).join(', ')}`).join('\n');
  } catch (e) {
    $('#voices').textContent = e.message;
  }
};

// ---------- catálogo ----------
let catalog = null;
let filter = null;
async function loadCatalog() {
  catalog ??= await api('/api/catalog');
  const chips = (list, el) => {
    $(el).innerHTML = list.map((x) => `<button class="chip ${filter === x ? 'active' : ''}">${esc(x)}</button>`).join('');
    $$(`${el} .chip`).forEach(
      (b) =>
        (b.onclick = () => {
          filter = filter === b.textContent ? null : b.textContent;
          loadCatalog();
        }),
    );
  };
  chips(catalog.functions, '#fn-chips');
  chips(catalog.industries, '#ind-chips');
  const items = catalog.templates.filter((t) => !filter || t.category?.function === filter || t.category?.industry === filter);
  $('#catalog-grid').innerHTML = items.length
    ? items.map((t) => card(t, `<button class="primary use" data-tpl="${esc(t.id)}">Usar plantilla</button>`)).join('')
    : '<p class="muted">No hay plantillas para este filtro todavía.</p>';
  $$('#catalog-grid .use').forEach(
    (b) =>
      (b.onclick = async (e) => {
        e.stopPropagation();
        const a = await post(`/api/catalog/${b.dataset.tpl}/use`);
        openAgent(a.id);
      }),
  );
}

// ---------- importar ----------
function showReport(r) {
  $('#import-result').textContent =
    r.agents.map((a) => `✔ ${a.name} (${a.id}): ${a.topics} temas, ${a.knowledge} fuentes, ${a.actions} acciones`).join('\n') +
    (r.warnings.length ? `\n\nRevisar:\n${r.warnings.map((w) => `⚠ ${w}`).join('\n')}` : '');
}
$('#zip-upload').onclick = async () => {
  const f = $('#zip-input').files[0];
  if (!f) return alert('Selecciona el .zip de la solución');
  $('#import-result').textContent = 'Importando…';
  try {
    showReport(await api('/api/import/solution', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: f }));
  } catch (e) {
    $('#import-result').textContent = `✖ ${e.message}`;
  }
};
$('#topic-import').onclick = async () => {
  try {
    showReport(await post('/api/import/topic', { yaml: $('#topic-yaml').value, agentName: $('#topic-agent-name').value || undefined }));
  } catch (e) {
    $('#import-result').textContent = `✖ ${e.message}`;
  }
};

// ---------- inicio ----------
const IDEAS = [
  'Cuando llegue un pedido de Shopify avisa en Slack',
  'Atiende a clientes por Telegram con un agente',
  'Cada mañana envíame el clima por Telegram',
  'Cuando alguien responda mi Typeform, crea un contacto en HubSpot',
];
$('#quick-ideas').innerHTML = IDEAS.map((i) => `<button type="button">${esc(i)}</button>`).join('');
$$('#quick-ideas button').forEach(
  (b) =>
    (b.onclick = () => {
      $('#quick-input').value = b.textContent;
      $('#quick-input').focus();
    }),
);

// Nombre corto a partir de la descripción: las primeras palabras con mayúscula inicial
function nameFrom(text) {
  const words = text.replace(/[«»"'.,;:!?¿¡]/g, '').split(/\s+/).filter(Boolean).slice(0, 5);
  const name = words.join(' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

$('#quick-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#quick-input').value.trim();
  if (!text) return $('#quick-input').focus();
  const btn = $('#quick-form button');
  btn.disabled = true;
  btn.textContent = 'Creando…';
  try {
    const name = nameFrom(text);
    const a = await post('/api/agents', {
      name,
      icon: '✨',
      description: text,
      instructions: `Eres un asistente cuyo objetivo es: ${text}.\nSé amable, breve y claro. Si no sabes algo, dilo y ofrece alternativas.`,
      greeting: '¡Hola! ¿En qué te puedo ayudar hoy?',
      voice: { enabled: true },
    });
    $('#quick-input').value = '';
    openAgent(a.id);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crear agente';
  }
};

$$('[data-go]').forEach(
  (el) =>
    (el.onclick = async () => {
      const go = el.dataset.go;
      if (go === 'new') return $('#quick-input').focus();
      if (go === 'blank') {
        const a = await post('/api/agents', { name: 'Agente en blanco', icon: '🤖', instructions: 'Eres un asistente útil.' });
        return openAgent(a.id, 'editor');
      }
      show(go);
    }),
);

async function loadHome() {
  const agents = await api('/api/agents');
  $('#recent-list').innerHTML = agents.length
    ? agents
        .slice(0, 6)
        .map((a) => `<button class="recent-item" data-id="${esc(a.id)}"><span class="ri-icon">${esc(a.icon ?? '🤖')}</span>${esc(a.name)}</button>`)
        .join('')
    : '<p class="muted">Todavía no hay agentes: crea el primero arriba.</p>';
  $$('#recent-list .recent-item').forEach((b) => (b.onclick = () => openAgent(b.dataset.id)));
}

// ---------- conectar ----------
async function loadConnect() {
  const { baseUrl, root, tenantSlug } = await api('/api/connect');
  const apiKey = 'TU_CLAVE';
  const agents = await api('/api/agents');
  const agentId = agents[0]?.id ?? 'mi-agente';
  $('#goto-keys').hidden = !can('tenant.apikeys.manage');
  $('#hooks-base').innerHTML = `Webhooks de tu empresa: <code>${esc(baseUrl)}/hooks/${esc(tenantSlug)}/&lt;id-del-flujo&gt;</code>`;
  $('#openapi-link').href = `${baseUrl}/v1/openapi.json`;
  $('#openapi-link').textContent = `${baseUrl}/v1/openapi.json`;
  $('#snip-rest').textContent = `curl ${baseUrl}/v1/agents/${agentId}/chat \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hola", "session_id": null}'`;
  $('#snip-openai').textContent = `from openai import OpenAI

client = OpenAI(base_url="${baseUrl}/v1", api_key="${apiKey}")
r = client.chat.completions.create(
    model="${agentId}",
    messages=[{"role": "user", "content": "Hola"}],
)
print(r.choices[0].message.content)`;
  $('#snip-mcp-http').textContent = JSON.stringify(
    { mcpServers: { 'agent-studio': { type: 'http', url: `${baseUrl}/mcp`, headers: { Authorization: `Bearer ${apiKey}` } } } },
    null,
    2,
  );
  $('#snip-mcp-stdio').textContent = JSON.stringify(
    { mcpServers: { 'agent-studio': { command: 'npm', args: ['--prefix', root, 'run', '-s', 'mcp'], env: { AGENT_STUDIO_MCP_KEY: apiKey } } } },
    null,
    2,
  );
}
const copy = async (text, el) => {
  await navigator.clipboard.writeText(text);
  const old = el.textContent;
  if (el.tagName === 'BUTTON') {
    el.textContent = '✔ Copiado';
    setTimeout(() => (el.textContent = old), 1200);
  }
};
$$('.snip').forEach((pre) => (pre.onclick = () => copy(pre.textContent, pre)));
$('#goto-keys').onclick = () => show('settings', 'apikeys');
// "Falta conectar X" en un módulo de negocio abre esa app en el marketplace
document.addEventListener('as:open-app', async (e) => {
  show('modules');
  await openAppDetail(e.detail);
});

initMetrics(api);
initFlows(api, post);
initSettings(api, post, refreshContext, show);
initPlatform(api, post, () => location.reload());
// El asistente toma el control de la caja de Inicio: escribir → onboarding → editor del flujo
initAssistant(post, show);
// Primero la sesión (usuarios en MariaDB); luego se carga la app
ensureAuth(async () => {
  try { await refreshContext(); } catch (e) { console.warn('contexto:', e.message); }
  loadStatus();
  if (ctx && !ctx.tenant) return show('notenant');
  if (can('agents.read')) loadHome();
  else $('#recent-list').innerHTML = '';
});
