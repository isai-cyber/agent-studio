// Base de conocimiento: trocea las fuentes del agente y recupera los fragmentos
// más relevantes con BM25 (sin embeddings, así no depende de otro proveedor).
import { readFile } from 'node:fs/promises';
import type { AgentDef } from './types.ts';
import { resolveInside } from './tenancy/paths.ts';

interface Chunk {
  source: string;
  text: string;
  terms: Map<string, number>;
  length: number;
}

interface Index {
  chunks: Chunk[];
  df: Map<string, number>;
  avgLen: number;
}

const cache = new Map<string, Index>();

const STOP = new Set(
  'de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este si porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros the of and to in is for on that with are as be it this by or an'.split(' '),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function chunkText(text: string, size = 900, overlap = 150): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    out.push(clean.slice(i, i + size));
    if (i + size >= clean.length) break;
  }
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

async function loadSources(agent: AgentDef, agentDir: string): Promise<{ source: string; text: string }[]> {
  const out: { source: string; text: string }[] = [];
  for (const k of agent.knowledge ?? []) {
    try {
      if (k.type === 'text' && k.content) {
        out.push({ source: k.name ?? 'texto', text: k.content });
      } else if (k.type === 'file' && k.path) {
        out.push({ source: k.name ?? k.path, text: await readFile(resolveInside(agentDir, k.path), 'utf8') });
      } else if (k.type === 'url' && k.url) {
        const res = await fetch(k.url);
        const body = await res.text();
        out.push({ source: k.name ?? k.url, text: /html/i.test(res.headers.get('content-type') ?? '') ? htmlToText(body) : body });
      }
    } catch (err) {
      console.warn(`[knowledge] No se pudo cargar ${k.name ?? k.path ?? k.url}:`, (err as Error).message);
    }
  }
  return out;
}

export async function buildIndex(agent: AgentDef, agentDir: string): Promise<Index> {
  const sources = await loadSources(agent, agentDir);
  const chunks: Chunk[] = [];
  const df = new Map<string, number>();
  for (const s of sources) {
    for (const text of chunkText(s.text)) {
      const tokens = tokenize(text);
      const terms = new Map<string, number>();
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      chunks.push({ source: s.source, text, terms, length: tokens.length });
    }
  }
  const avgLen = chunks.reduce((a, c) => a + c.length, 0) / Math.max(chunks.length, 1);
  const index = { chunks, df, avgLen };
  cache.set(cacheKey(agent), index);
  return index;
}

// La caché va por empresa + agente: dos empresas pueden tener agentes con el mismo id
const cacheKey = (agent: AgentDef) => `${agent.tenantId ?? 0}/${agent.id}`;

export function invalidate(tenantId: number, agentId: string): void {
  cache.delete(`${tenantId}/${agentId}`);
}

export async function search(agent: AgentDef, agentDir: string, query: string, k = 4): Promise<{ source: string; text: string }[]> {
  if (!agent.knowledge?.length) return [];
  const index = cache.get(cacheKey(agent)) ?? (await buildIndex(agent, agentDir));
  const q = tokenize(query);
  const N = index.chunks.length;
  const k1 = 1.4;
  const b = 0.75;
  const scored = index.chunks.map((c) => {
    let score = 0;
    for (const t of q) {
      const f = c.terms.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.length) / index.avgLen)));
    }
    return { c, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map((s) => ({ source: s.c.source, text: s.c.text }));
}
