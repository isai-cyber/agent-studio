// Modo orquestado (AGENT_BACKEND=orquestado o Ajustes → Modo de los agentes):
// tres modelos, cada uno para lo que mejor (y más barato) hace.
//
//   1. Jev decide.  Para cada mensaje, una pregunta tipada: ¿se responde con texto
//      o es una tarea compleja? (y, aparte, qué tema guiado toca). Cuesta
//      $0,042 por millón de tokens y tarda menos de medio segundo.
//   2. Qwen o DeepSeek orquestan.  Responden lo sencillo con sus herramientas
//      (acciones, MCP, módulos) y, si algo no lo pueden hacer, lo delegan en
//      Claude Code con la herramienta delegar_a_claude_code.
//   3. Claude Code hace lo complejo.  Recibe directamente lo que Jev marca como
//      complejo, o lo que le delega el orquestador. Dentro, también puede usar Jev
//      y el modelo rápido como herramientas (src/claude-code.ts).
//
// Sin clave de Jev, la decisión la toma el propio orquestador (delegando o no).
// Si Claude Code falla, responde el orquestador.
import type { AgentDef, Session } from './types.ts';
import type { ToolSpec } from './llm.ts';
import { jevConfigured, jevChoose } from './jev.ts';
import { send as claudeCodeSend } from './claude-code.ts';
import { timed, setRoute } from './metrics.ts';

export const DELEGATE_TOOL = 'delegar_a_claude_code';

const ROUTES = {
  directa: 'Se responde con un mensaje: saludo, pregunta, duda, dato del conocimiento del agente o una acción sencilla.',
  compleja: 'Necesita varios pasos, investigar, analizar documentos o datos largos, cálculos, redactar algo extenso o escribir código.',
};

// ¿Va directo a Claude Code? Solo si Jev lo tiene claro; si duda, decide el orquestador.
export async function routeMessage(agent: AgentDef, session: Session, text: string): Promise<'claude' | 'orquestador'> {
  if (!jevConfigured() || !text.trim()) return 'orquestador';
  const recent = session.history.slice(-4).map((m) => `${m.role}: ${String(m.content ?? '').slice(0, 300)}`).join('\n');
  try {
    const r = await jevChoose(
      { agente: `${agent.name}${agent.description ? ` — ${agent.description}` : ''}`, conversacion: recent, mensaje: text },
      ROUTES,
      '¿Qué necesita el último mensaje del usuario para ser atendido?',
      { tenantId: agent.tenantId, purpose: 'orquestar' },
    );
    return r?.choice === 'compleja' ? 'claude' : 'orquestador';
  } catch (err) {
    console.warn('[orquestador] Jev no pudo decidir:', (err as Error).message);
    return 'orquestador';
  }
}

export async function runClaudeCode(agent: AgentDef, session: Session, prompt: string): Promise<string> {
  setRoute('claude-code');
  return (await timed('claude-code', () => claudeCodeSend(agent, session, prompt))).text;
}

// Herramienta que el orquestador (Qwen/DeepSeek) usa para pasar a Claude Code lo que no puede hacer
export function delegateTool(agent: AgentDef, session: Session): { spec: ToolSpec; run: (args: Record<string, unknown>) => Promise<string> } {
  return {
    spec: {
      type: 'function',
      function: {
        name: DELEGATE_TOOL,
        description: 'Pasa a Claude Code (un agente más potente) una tarea que tú no puedes resolver bien: varios pasos, investigar, analizar mucho texto, cálculos o código. Devuelve su respuesta para el usuario.',
        parameters: { type: 'object', properties: { tarea: { type: 'string', description: 'Qué debe hacer, con todos los datos necesarios' } }, required: ['tarea'] },
      },
    },
    run: async (args) => {
      try {
        return JSON.stringify({ respuesta: await runClaudeCode(agent, session, String(args.tarea ?? '')) });
      } catch (err) {
        return JSON.stringify({ error: `Claude Code no pudo hacerlo: ${(err as Error).message}. Responde tú lo mejor que puedas.` });
      }
    },
  };
}
