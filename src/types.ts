// Definición de un agente. Se guarda como agents/<tenant_id>/<id>/agent.yaml

export type Step =
  | { type: 'message'; text: string }
  | { type: 'question'; prompt: string; variable: string; options?: string[] }
  | { type: 'condition'; if: string; then: Step[]; else?: Step[] }
  | { type: 'action'; action: string; inputs?: Record<string, string>; saveAs?: string }
  | { type: 'generate'; prompt?: string; useKnowledge?: boolean }
  | { type: 'set'; variable: string; value: string }
  | { type: 'goto'; topic: string }
  | { type: 'end' };

export interface Topic {
  name: string;
  description?: string;
  triggers: string[];
  steps: Step[];
}

export interface KnowledgeSource {
  type: 'text' | 'file' | 'url';
  name?: string;
  content?: string; // type=text
  path?: string; // type=file, relativo a la carpeta del agente
  url?: string; // type=url
}

export interface ActionDef {
  name: string;
  description: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string; // admite {{param}} en la URL
  headers?: Record<string, string>; // admite {{env.NOMBRE}}
  parameters?: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface AgentDef {
  id: string;
  tenantId?: number; // solo en memoria: empresa del agente (no se guarda en el YAML)
  name: string;
  description?: string;
  icon?: string;
  category?: { function?: string; industry?: string; useCase?: string };
  language?: string;
  instructions: string;
  greeting?: string;
  model?: string;
  temperature?: number;
  voice?: { voiceId?: string; model?: string; enabled?: boolean };
  topics?: Topic[];
  knowledge?: KnowledgeSource[];
  actions?: ActionDef[];
  source?: string; // p. ej. "copilot-studio-import" o "template"
  // Servidores MCP cuyas herramientas puede usar el agente al responder
  mcpServers?: { name: string; url?: string; transport?: 'http' | 'sse' | 'stdio'; headers?: Record<string, string>; command?: string; args?: string[] }[];
  // Enlace con NanoClaw cuando AGENT_BACKEND=nanoclaw
  nanoclaw?: { conversationId: string; folder: string; provider: string; model: string; syncedAt: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Session {
  id: string;
  tenantId: number;
  agentId: string;
  history: ChatMessage[];
  variables: Record<string, unknown>;
  // Pila de ejecución del tema activo (para retomar tras una pregunta)
  pending?: { topic: string; stack: Step[][]; waitingFor?: { variable: string; options?: string[] } };
}
