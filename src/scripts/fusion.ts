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

// ─── Run params (temperature / reasoning effort) ─────────────────────────────

export interface RunParams {
  temperature: number | null;                   // null = omit (provider default)
  effort: 'off' | 'low' | 'medium' | 'high';    // 'off' = omit reasoning param
}

export const DEFAULT_RUN_PARAMS: RunParams = { temperature: null, effort: 'off' };

// Settings store the raw input string; convert + clamp here.
export function toRunParams(s: { temperature: string; effort: RunParams['effort'] }): RunParams {
  const t = parseFloat(s.temperature);
  return {
    temperature: Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : null,
    effort: s.effort ?? 'off',
  };
}

export function buildRequestBody(
  model: string,
  messages: { role: string; content: string }[],
  params: RunParams = DEFAULT_RUN_PARAMS
): Record<string, unknown> {
  return {
    model,
    messages,
    stream: true,
    usage: { include: true },
    ...(params.temperature !== null ? { temperature: params.temperature } : {}),
    ...(params.effort !== 'off' ? { reasoning: { effort: params.effort } } : {}),
  };
}

// ─── Presets (computed from the live model list) ─────────────────────────────

export interface Presets {
  quality: string[];
  budget: string[];
}

export const MAX_MODELS = 8; // OpenRouter Fusion allows 1–8 panel models

const modelPrice = (m: ORModel) => {
  const p = parseFloat(m.pricing?.prompt ?? '0') + parseFloat(m.pricing?.completion ?? '0');
  return Number.isFinite(p) ? p : 0;
};
const modelCtx = (m: ORModel) => m.context_length ?? m.top_provider?.context_length ?? 0;
const modelAuthor = (id: string) => id.split('/')[0] ?? id;

// One model per author first (panel diversity), then fill by rank
function pickDiverse(ordered: ORModel[], n: number): string[] {
  const picked: ORModel[] = [];
  const seen = new Set<string>();
  for (const m of ordered) {
    if (picked.length === n) break;
    if (seen.has(modelAuthor(m.id))) continue;
    seen.add(modelAuthor(m.id));
    picked.push(m);
  }
  for (const m of ordered) {
    if (picked.length === n) break;
    if (!picked.includes(m)) picked.push(m);
  }
  return picked.map((m) => m.id);
}

export function computePresets(models: ORModel[]): Presets {
  // negative price = variable/unknown sentinel (alias/router models) — unrankable, skip
  const ranked = models.filter((m) => modelPrice(m) >= 0);
  const byPriceDesc = [...ranked].sort((a, b) => modelPrice(b) - modelPrice(a) || modelCtx(b) - modelCtx(a));
  const paidAsc = ranked.filter((m) => modelPrice(m) > 0).sort((a, b) => modelPrice(a) - modelPrice(b) || modelCtx(b) - modelCtx(a));
  const freeByCtx = ranked.filter((m) => modelPrice(m) === 0).sort((a, b) => modelCtx(b) - modelCtx(a));
  return {
    quality: pickDiverse(byPriceDesc, 3),
    budget: pickDiverse([...paidAsc, ...freeByCtx], 3),
  };
}

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
  onChunk: (text: string) => void,
  params: RunParams = DEFAULT_RUN_PARAMS
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
      body: JSON.stringify(buildRequestBody(model, messages, params)),
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

// Pause automatic synthesis when a turn has both successes and failures —
// fusing incomplete inputs wastes a synthesis call if the user then retries
// the failed models. Explicit "Run synthesis" is unaffected.
export function shouldPauseSynthesis(responses: ModelResponse[]): boolean {
  const { ok, failed } = partitionResponses(responses);
  return ok.length >= 1 && failed.length >= 1;
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

// Shared response formatting for the judge prompt
function formatResponses(responses: ModelResponse[]): string {
  return responses
    .map((r, i) => {
      const note = r.finishReason === 'length' ? ' (cut off mid-generation)' : '';
      return `### Response ${i + 1} (${r.model})${note}\n${r.content}`;
    })
    .join('\n\n');
}

// ─── Judge / writer (two-stage synthesis, per OpenRouter Fusion research) ─────

export const JUDGE_KEYS = ['consensus', 'contradictions', 'partial_coverage', 'unique_insights', 'blind_spots'] as const;

export interface JudgeAnalysis {
  consensus: string[];
  contradictions: string[];
  partial_coverage: string[];
  unique_insights: string[];
  blind_spots: string[];
}

export function buildJudgePrompt(userMessage: string, responses: ModelResponse[]): string {
  return `You are a judge comparing multiple AI model responses to the same user question. Analyze them and return ONLY a JSON object — no markdown fences, no prose — with exactly these keys, each an array of strings:
- "consensus": points all or most responses agree on (treat as higher confidence)
- "contradictions": where responses disagree — say which position is better supported and why
- "partial_coverage": relevant points only some responses addressed
- "unique_insights": valuable points contributed by a single response
- "blind_spots": relevant aspects none of the responses addressed

Keep every item one concise sentence. Use [] for empty categories.

## User Question
${userMessage}

## Model Responses
${formatResponses(responses)}`;
}

export function parseJudgeAnalysis(text: string): JudgeAnalysis | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj: unknown;
  try { obj = JSON.parse(stripped); } catch { return null; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (!JUDGE_KEYS.some((k) => Array.isArray(rec[k]))) return null;
  const toArr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    consensus: toArr(rec.consensus),
    contradictions: toArr(rec.contradictions),
    partial_coverage: toArr(rec.partial_coverage),
    unique_insights: toArr(rec.unique_insights),
    blind_spots: toArr(rec.blind_spots),
  };
}

const JUDGE_SECTION_TITLES: Record<(typeof JUDGE_KEYS)[number], string> = {
  consensus: 'Consensus',
  contradictions: 'Contradictions',
  partial_coverage: 'Partial coverage',
  unique_insights: 'Unique insights',
  blind_spots: 'Blind spots',
};

// Bold titles (not headings): renders compactly inside the fused card and in MD exports
export function analysisToMarkdown(a: JudgeAnalysis): string {
  const sections: string[] = [];
  for (const key of JUDGE_KEYS) {
    if (a[key].length === 0) continue;
    sections.push(`**${JUDGE_SECTION_TITLES[key]}**\n${a[key].map((i) => `- ${i}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

export function buildWriterPrompt(userMessage: string, analysisText: string): string {
  return `You are writing the definitive answer to the user's question. A judge has compared several AI model responses to this question and produced the analysis below. Write a single, comprehensive, well-structured answer grounded in that analysis:
- Treat consensus points as high-confidence facts
- Resolve contradictions in favor of the better-supported position
- Work in the unique insights where they add value
- Address the blind spots if you can
Do not mention the judge, the analysis, or the other models — just answer the question directly.

## User Question
${userMessage}

## Judge Analysis
${analysisText}

## Your Answer`;
}

export interface SynthesisOutcome {
  fusedContent: string;
  analysisText: string;              // markdown (or raw judge text); '' when skipped or judge failed
  judgeError: string | null;         // set when the judge call failed (writer not attempted)
  result: StreamResult | null;       // writer call result; null when no writer call was made
  skipped: 'all-failed' | 'single' | 'partial-failure' | null;
  model: string | null;              // model id used for judge + writer
}

export interface SynthesisOptions {
  apiKey: string;
  fusionModel: string;
  models: string[];
  userMessage: string;
  responses: ModelResponse[];
  params?: RunParams;
  existingAnalysis?: string | null;  // reuse a stored analysis (writer retry) instead of re-billing the judge
  onJudgeStart?: () => void;
  onJudgeDone?: (analysisText: string, judgeEntry: LogEntry | null) => void; // entry null when analysis was reused
  onChunk: (text: string) => void;
  _stream?: typeof streamCompletion; // test seam
}

export async function runSynthesis(opts: SynthesisOptions): Promise<SynthesisOutcome> {
  const { apiKey, fusionModel, models, userMessage, responses, onChunk } = opts;
  const params = opts.params ?? DEFAULT_RUN_PARAMS;
  const stream = opts._stream ?? streamCompletion;

  const decision = decideSynthesis(responses);
  if (decision.mode === 'all-failed') return { fusedContent: '', analysisText: '', judgeError: null, result: null, skipped: 'all-failed', model: null };
  if (decision.mode === 'single') return { fusedContent: decision.response.content, analysisText: '', judgeError: null, result: null, skipped: 'single', model: null };
  const fusionModelId = fusionModel === 'auto' ? models[0]! : fusionModel;

  let analysisText = opts.existingAnalysis ?? '';
  if (analysisText) {
    opts.onJudgeDone?.(analysisText, null);
  } else {
    opts.onJudgeStart?.();
    // Judge is "non-streamed" in the research sense: nothing renders mid-flight.
    // Implementation still uses the SSE path (no-op onChunk) to reuse all plumbing.
    const judgeMessages = [{ role: 'user', content: buildJudgePrompt(userMessage, decision.responses) }];
    const judgeResult = await stream(apiKey, fusionModelId, judgeMessages, () => {}, params);
    if (judgeResult.error) {
      opts.onJudgeDone?.('', buildLogEntry('judge', fusionModelId, judgeResult));
      return { fusedContent: '', analysisText: '', judgeError: judgeResult.error, result: null, skipped: null, model: fusionModelId };
    }
    const parsed = parseJudgeAnalysis(judgeResult.content);
    analysisText = parsed ? analysisToMarkdown(parsed) : judgeResult.content;
    opts.onJudgeDone?.(analysisText, buildLogEntry('judge', fusionModelId, judgeResult));
  }

  const writerMessages = [{ role: 'user', content: buildWriterPrompt(userMessage, analysisText) }];
  const result = await stream(apiKey, fusionModelId, writerMessages, onChunk, params);
  return { fusedContent: result.content, analysisText, judgeError: null, result, skipped: null, model: fusionModelId };
}

export async function runFusion(params: {
  apiKey: string;
  models: string[];
  messages: { role: string; content: string }[];
  userMessage: string;
  fusionModel: string;
  runParams?: RunParams;
  onModelChunk: (model: string, chunk: string) => void;
  onModelDone: (model: string, result: StreamResult) => void;
  onJudgeStart?: () => void;
  onJudgeDone?: (analysisText: string, judgeEntry: LogEntry | null) => void;
  onFusionChunk: (chunk: string) => void;
  onFusionDone: (outcome: SynthesisOutcome) => void;
}): Promise<void> {
  const { apiKey, models, messages, userMessage, fusionModel, runParams,
    onModelChunk, onModelDone, onJudgeStart, onJudgeDone, onFusionChunk, onFusionDone } = params;

  const responses: ModelResponse[] = await Promise.all(
    models.map(async (model) => {
      const result = await streamCompletion(apiKey, model, messages, (c) => onModelChunk(model, c), runParams);
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

  if (shouldPauseSynthesis(responses)) {
    onFusionDone({ fusedContent: '', analysisText: '', judgeError: null, result: null, skipped: 'partial-failure', model: null });
    return;
  }
  const outcome = await runSynthesis({ apiKey, fusionModel, models, userMessage, responses, params: runParams, onJudgeStart, onJudgeDone, onChunk: onFusionChunk });
  onFusionDone(outcome);
}
