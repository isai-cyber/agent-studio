// Asistente de automatización (chat flotante) y onboarding desde Inicio.
import { openFlowById, getCurrentFlowId, refreshIfOpen } from './flows.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// **negrita** y saltos de línea
const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

let post;
let show;
let flowId = null; // flujo sobre el que trabaja el asistente

const SUGGESTIONS = [
  'Cuando llegue un pedido de Shopify avisa en Slack',
  'Atiende a clientes por Telegram con un agente',
  'Cada mañana envíame el clima por Telegram',
  'Cuando un agente escale crea un ticket en Zendesk',
  'Conecta https://mcp.deepwiki.com/mcp y resume',
];

function addMsg(role, html) {
  const box = $('#asst-messages');
  const div = document.createElement('div');
  div.className = `asst-msg ${role}`;
  div.innerHTML = html;
  box.append(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function flowCard(flow) {
  return `<div class="asst-flow"><b>${esc(flow.name)}</b><span>${flow.active ? '● Publicado' : 'Borrador'}</span>
    <button class="primary" data-open-flow="${esc(flow.id)}">Abrir en el editor</button></div>`;
}

function bindOpen(el) {
  el.querySelectorAll('[data-open-flow]').forEach((b) => (b.onclick = () => goToFlow(b.dataset.openFlow)));
}

async function goToFlow(id) {
  show('flows');
  await openFlowById(id);
}

export function openAssistant(intro) {
  $('#asst').hidden = false;
  $('#asst-fab').hidden = true;
  if (intro) addMsg('bot', intro);
  setTimeout(() => $('#asst-input').focus(), 50);
}

async function send(text) {
  if (!text.trim()) return;
  addMsg('user', esc(text));
  const typing = addMsg('bot typing', '<span></span><span></span><span></span>');
  try {
    const r = await post('/api/assistant/chat', { message: text, flowId: getCurrentFlowId() ?? flowId });
    typing.remove();
    flowId = r.flow.id;
    const msg = addMsg('bot', `${fmt(r.reply)}${flowCard(r.flow)}`);
    bindOpen(msg);
    // Si el flujo está abierto en el editor se actualiza; si es nuevo, se abre
    if (getCurrentFlowId() === r.flow.id) refreshIfOpen(r.flow.id);
    else if (r.created) goToFlow(r.flow.id);
  } catch (e) {
    typing.remove();
    addMsg('bot error', esc(e.message));
  }
}

// ---------- onboarding: escribir en Inicio → automatización lista en el editor ----------

const STEPS = ['Entendiendo lo que quieres', 'Eligiendo apps, webhooks y conexiones', 'Creando tu agente y tu automatización', 'Abriendo el editor'];

async function onboarding(text) {
  const ov = $('#onboard');
  ov.hidden = false;
  $('#onboard-text').textContent = `«${text}»`;
  $('#onboard-steps').innerHTML = STEPS.map((s, i) => `<li data-i="${i}"><span class="ob-dot"></span>${esc(s)}</li>`).join('');
  const mark = (i, state) => ov.querySelector(`li[data-i="${i}"]`)?.setAttribute('data-state', state);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  mark(0, 'run');
  const req = post('/api/assistant/plan', { text });
  await wait(600); mark(0, 'done'); mark(1, 'run');
  await wait(600); mark(1, 'done'); mark(2, 'run');
  let r;
  try {
    r = await req;
  } catch (e) {
    ov.hidden = true;
    return alert(e.message);
  }
  mark(2, 'done'); mark(3, 'run');
  await wait(450);
  mark(3, 'done');
  await wait(250);
  ov.hidden = true;
  flowId = r.flow.id;
  await goToFlow(r.flow.id);
  openAssistant();
  bindOpen(addMsg('bot', `${fmt(r.reply)}${flowCard(r.flow)}`));
}

export function initAssistant(postFn, showFn) {
  post = postFn;
  show = showFn;
  $('#asst-fab').onclick = () => openAssistant($('#asst-messages').children.length ? null : '¡Hola! Dime qué quieres automatizar y lo monto por ti: conecto apps, webhooks, APIs o servidores MCP. Después puedes pedirme cambios hablando.');
  $('#asst-close').onclick = () => { $('#asst').hidden = true; $('#asst-fab').hidden = false; };
  $('#asst-sugs').innerHTML = SUGGESTIONS.map((s) => `<button>${esc(s)}</button>`).join('');
  $('#asst-sugs').querySelectorAll('button').forEach((b) => (b.onclick = () => send(b.textContent)));
  $('#asst-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#asst-input').value;
    $('#asst-input').value = '';
    send(v);
  };
  // Inicio: escribir lo que quieres → onboarding → editor del flujo
  $('#quick-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#quick-input').value.trim();
    if (!text) return $('#quick-input').focus();
    $('#quick-input').value = '';
    onboarding(text);
  };
}
