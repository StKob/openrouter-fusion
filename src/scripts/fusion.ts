import type { ModelResponse, Usage, LogEntry } from './storage';

// ─── Model List ───────────────────────────────────────────────────────────────

export interface ORModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
  top_provider?: { context_length?: number };
}

let _modelCache: ORModel[] | null = null;

export async function fetchModels(apiKey: string): Promise<ORModel[]> {
  if (_modelCache) return _modelCache;
  // /models/user = catalog filtered by this key's privacy settings & guardrails
  // (plain /models is the global catalog and can list unroutable models)
  const res = await fetch('https://openrouter.ai/api/v1/models/user', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`);
  const json = await res.json() as { data: ORModel[] };
  _modelCache = json.data.sort((a, b) => a.name.localeCompare(b.name));
  return _modelCache;
}

export function formatPricePer1M(pricing?: { prompt: string; completion: string }): string {
  if (!pricing) return '';
  const per1M = (s: string) => parseFloat((parseFloat(s) * 1e6).toFixed(3));
  const inP = per1M(pricing.prompt);
  const outP = per1M(pricing.completion);
  if (!Number.isFinite(inP) || !Number.isFinite(outP) || inP < 0 || outP < 0) return ''; // -1 = variable/unknown (alias models)
  if (!inP && !outP) return 'free';
  return `$${inP}/$${outP} per 1M`;
}

export function clearModelCache(): void {
  _modelCache = null;
}

// ─── Presets ──────────────────────────────────────────────────────────────────

export const PRESETS = {
  quality: [
    'openai/gpt-4o',
    'anthropic/claude-3.5-sonnet',
    'google/gemini-pro-1.5',
  ],
  budget: [
    'openai/gpt-4o-mini',
    'anthropic/claude-3-haiku',
    'google/gemini-flash-1.5',
  ],
};

// ─── Stream result ────────────────────────────────────────────────────────────

export interface StreamResult {
  content: string;
  finishReason: string | null;
  usage: Usage | null;
  error: string | null;
  genId: string | null;
  provider: string | null;
  startedAt: number;
  durationMs: number;
}

export function newStreamResult(): StreamResult {
  return {
    content: '', finishReason: null, usage: null, error: null,
    genId: null, provider: null, startedAt: Date.now(), durationMs: 0,
  };
}

// Applies one SSE `data:` payload to the accumulating result.
// Returns the text delta if the chunk carried one, else null.
export function applyChunk(acc: StreamResult, data: string): string | null {
  if (data === '[DONE]') return null;
  let json: any;
  try { json = JSON.parse(data); } catch { return null; }
  if (json.error) {
    acc.error = typeof json.error === 'string' ? json.error : (json.error.message ?? JSON.stringify(json.error));
    return null;
  }
  if (json.id && !acc.genId) acc.genId = json.id;
  if (json.provider && !acc.provider) acc.provider = json.provider;
  const choice = json.choices?.[0];
  if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
  if (json.usage) {
    acc.usage = {
      promptTokens: json.usage.prompt_tokens ?? 0,
      completionTokens: json.usage.completion_tokens ?? 0,
      cost: json.usage.cost ?? 0,
    };
  }
  const delta = choice?.delta?.content;
  if (delta) { acc.content += delta; return delta; }
  return null;
}

// Splits an SSE text buffer into complete lines + the trailing partial line.
export function splitSSEBuffer(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  return { lines, rest };
}

export function buildLogEntry(kind: LogEntry['kind'], model: string, r: StreamResult): LogEntry {
  return {
    ts: r.startedAt,
    durationMs: r.durationMs,
    kind,
    model,
    genId: r.genId,
    provider: r.provider,
    status: r.error ? 'error' : r.finishReason === 'length' ? 'truncated' : 'ok',
    finishReason: r.finishReason,
    promptTokens: r.usage?.promptTokens ?? null,
    completionTokens: r.usage?.completionTokens ?? null,
    cost: r.usage?.cost ?? null,
    ...(r.error ? { error: r.error } : {}),
  };
}

// ─── Streaming ────────────────────────────────────────────────────────────────

export function buildMessages(
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push(...conversationHistory);
  messages.push({ role: 'user', content: userMessage });
  return messages;
}

export async function streamCompletion(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void
): Promise<StreamResult> {
  const acc = newStreamResult();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.origin,
        'X-Title': 'OpenRouter Fusion Replica',
      },
      body: JSON.stringify({ model, messages, stream: true, usage: { include: true } }),
    });

    if (!res.ok) {
      acc.error = `[${res.status}] ${await res.text()}`;
      acc.durationMs = Date.now() - acc.startedAt;
      return acc;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { lines, rest } = splitSSEBuffer(buffer);
      buffer = rest;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const delta = applyChunk(acc, trimmed.slice(6));
        if (delta) onChunk(delta);
        if (acc.error) break;
      }
      if (acc.error) break;
    }
    if (acc.error) { try { await reader.cancel(); } catch {} }
  } catch (err: unknown) {
    acc.error = err instanceof Error ? err.message : String(err);
  }
  acc.durationMs = Date.now() - acc.startedAt;
  return acc;
}

// ─── Fusion ───────────────────────────────────────────────────────────────────

export function partitionResponses(responses: ModelResponse[]): { ok: ModelResponse[]; failed: ModelResponse[] } {
  const ok: ModelResponse[] = [];
  const failed: ModelResponse[] = [];
  for (const r of responses) (r.content.trim() && !r.error ? ok : failed).push(r);
  return { ok, failed };
}

export type SynthesisDecision =
  | { mode: 'run'; responses: ModelResponse[] }
  | { mode: 'single'; response: ModelResponse }
  | { mode: 'all-failed' };

export function decideSynthesis(responses: ModelResponse[]): SynthesisDecision {
  const { ok } = partitionResponses(responses);
  if (ok.length === 0) return { mode: 'all-failed' };
  if (ok.length === 1) return { mode: 'single', response: ok[0]! };
  return { mode: 'run', responses: ok };
}

export function buildFusionPrompt(userMessage: string, responses: ModelResponse[]): string {
  const parts = responses
    .map((r, i) => {
      const note = r.finishReason === 'length' ? ' (cut off mid-generation)' : '';
      return `### Response ${i + 1} (${r.model})${note}\n${r.content}`;
    })
    .join('\n\n');

  return `You are a synthesis AI. You have been given multiple AI model responses to the same user question. Your task is to analyze all responses and produce a single, comprehensive, well-structured answer that:
- Captures the best insights from each response
- Resolves any contradictions with sound reasoning
- Is more complete and accurate than any individual response
- Is clearly written and well-organized

## User Question
${userMessage}

## Model Responses
${parts}

## Your Fused Answer
Synthesize the above responses into the definitive best answer:`;
}

export interface SynthesisOutcome {
  fusedContent: string;
  result: StreamResult | null;           // null when no API call was made
  skipped: 'all-failed' | 'single' | null;
  model: string | null;                  // model id actually called for synthesis
}

export async function runSynthesis(
  apiKey: string,
  fusionModel: string,
  models: string[],
  userMessage: string,
  responses: ModelResponse[],
  onChunk: (text: string) => void
): Promise<SynthesisOutcome> {
  const decision = decideSynthesis(responses);
  if (decision.mode === 'all-failed') return { fusedContent: '', result: null, skipped: 'all-failed', model: null };
  if (decision.mode === 'single') return { fusedContent: decision.response.content, result: null, skipped: 'single', model: null };
  const fusionModelId = fusionModel === 'auto' ? models[0]! : fusionModel;
  const messages = [{ role: 'user', content: buildFusionPrompt(userMessage, decision.responses) }];
  const result = await streamCompletion(apiKey, fusionModelId, messages, onChunk);
  return { fusedContent: result.content, result, skipped: null, model: fusionModelId };
}

export async function runFusion(params: {
  apiKey: string;
  models: string[];
  messages: { role: string; content: string }[];
  userMessage: string;
  fusionModel: string;
  onModelChunk: (model: string, chunk: string) => void;
  onModelDone: (model: string, result: StreamResult) => void;
  onFusionChunk: (chunk: string) => void;
  onFusionDone: (outcome: SynthesisOutcome) => void;
}): Promise<void> {
  const { apiKey, models, messages, userMessage, fusionModel,
    onModelChunk, onModelDone, onFusionChunk, onFusionDone } = params;

  const responses: ModelResponse[] = await Promise.all(
    models.map(async (model) => {
      const result = await streamCompletion(apiKey, model, messages, (c) => onModelChunk(model, c));
      onModelDone(model, result);
      return {
        model,
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
        error: result.error,
      };
    })
  );

  const outcome = await runSynthesis(apiKey, fusionModel, models, userMessage, responses, onFusionChunk);
  onFusionDone(outcome);
}
