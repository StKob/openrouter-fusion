# Fusion-Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-call synthesis with OpenRouter's research-faithful two-stage judge→writer pipeline, add global temperature/reasoning-effort knobs, raise the panel cap to 8, and compute Quality/Budget presets from the live model list.

**Architecture:** All pure logic (prompts, JSON parsing, request bodies, preset ranking) lives in `src/scripts/fusion.ts` and is unit-tested; `src/pages/index.astro` only wires UI. The judge is a normal streaming call with a no-op chunk callback (reuses all existing SSE/usage/error plumbing; "non-streamed" means not streamed to the UI). Spec: `docs/superpowers/specs/2026-07-13-fusion-quality-design.md`.

**Tech Stack:** Astro (static) + TypeScript + Tailwind, vitest, OpenRouter chat/completions SSE. No new dependencies.

## Global Constraints

- Branch: `fusion-quality`. Commits authored as StKob (repo-local git identity already set — do not change it).
- No new dependencies of any kind.
- Judge JSON keys, exactly: `consensus`, `contradictions`, `partial_coverage`, `unique_insights`, `blind_spots` — each an array of strings.
- The writer receives the user question + judge analysis ONLY — never the raw panel responses.
- Temperature/effort apply to every call (panel, judge, writer); empty/`off` means omit the param entirely.
- Judge analysis reuse rule: synthesis runs the judge only when the turn has no stored `judgeAnalysis`; any mutation of `turn.modelResponses` (model retry, discard, run-added) clears the stored analysis.
- Gate for Tasks 1–7: `npm test` only (index.astro is intentionally broken mid-series while fusion.ts signatures change — same convention as the failure-handling plan). Task 8 adds `npx astro check` (0 errors) + `npm run build`.
- Task 9 (manual E2E) requires the user — STOP before it.

---

### Task 1: storage.ts — new Settings fields, `Turn.judgeAnalysis`, `judge` log kind, analysis in MD export

**Files:**
- Modify: `src/scripts/storage.ts`
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Settings` gains `temperature: string` (`''` = provider default) and `effort: 'off' | 'low' | 'medium' | 'high'`; `Turn` gains `judgeAnalysis?: string`; `LogEntry['kind']` gains `'judge'`; `getSettings()` returns the new defaults; `runToMarkdown` emits a `### Judge analysis` section. Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `tests/fusion.test.ts` (add `getSettings` to the existing storage import on line 3):

```ts
describe('getSettings', () => {
  it('returns defaults including temperature and effort outside a browser', () => {
    // vitest runs in node: localStorage access throws, the catch returns defaults
    expect(getSettings()).toEqual({ apiKey: '', fusionModel: 'auto', theme: 'dark', temperature: '', effort: 'off' });
  });
});

describe('runToMarkdown judge analysis', () => {
  it('includes the judge analysis section when present', () => {
    const run = { ...sampleRun, turns: [{ ...sampleRun.turns[0]!, judgeAnalysis: '**Consensus**\n- both agree' }] };
    const md = runToMarkdown(run);
    expect(md).toContain('### Judge analysis');
    expect(md).toContain('- both agree');
  });
  it('omits the section when absent', () => {
    expect(runToMarkdown(sampleRun)).not.toContain('### Judge analysis');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `getSettings` not imported / missing `temperature` in result; `### Judge analysis` not found.

- [ ] **Step 3: Implement**

In `src/scripts/storage.ts`:

Replace the `kind` line of `LogEntry`:

```ts
  kind: 'model' | 'synthesis' | 'retry' | 'judge';
```

Replace the `Turn` interface:

```ts
export interface Turn {
  userMessage: string;
  modelResponses: ModelResponse[];
  fusedResponse: string;
  judgeAnalysis?: string;   // judge's comparison — markdown, or raw judge text when JSON parse failed
  fusion?: FusionMeta;
  calls?: LogEntry[];
}
```

Replace the `Settings` interface and `getSettings`:

```ts
export interface Settings {
  apiKey: string;
  fusionModel: string;
  theme: 'dark' | 'light';
  temperature: string;                          // raw input value; '' = provider default (param omitted)
  effort: 'off' | 'low' | 'medium' | 'high';    // 'off' = reasoning param omitted
}

const SETTINGS_DEFAULTS: Settings = { apiKey: '', fusionModel: 'auto', theme: 'dark', temperature: '', effort: 'off' };

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...SETTINGS_DEFAULTS };
}
```

In `runToMarkdown`, insert immediately before the `### Fused answer` push:

```ts
    if (turn.judgeAnalysis) {
      lines.push('### Judge analysis', '', turn.judgeAnalysis, '');
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/storage.ts tests/fusion.test.ts
git commit -m "feat: settings temperature/effort fields, judge log kind, judgeAnalysis on turns"
```

---

### Task 2: fusion.ts — `RunParams`, `toRunParams`, `buildRequestBody`, `streamCompletion` params

**Files:**
- Modify: `src/scripts/fusion.ts`
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: `Settings` fields from Task 1.
- Produces (later tasks call these exact signatures):
  - `interface RunParams { temperature: number | null; effort: 'off' | 'low' | 'medium' | 'high' }`
  - `const DEFAULT_RUN_PARAMS: RunParams`
  - `toRunParams(s: { temperature: string; effort: RunParams['effort'] }): RunParams`
  - `buildRequestBody(model: string, messages: {role:string;content:string}[], params?: RunParams): Record<string, unknown>`
  - `streamCompletion(apiKey, model, messages, onChunk, params?: RunParams): Promise<StreamResult>` — params appended as optional 5th arg.

- [ ] **Step 1: Write the failing tests**

Append to `tests/fusion.test.ts` (add `buildRequestBody, toRunParams` to the fusion import):

```ts
describe('buildRequestBody', () => {
  const msgs = [{ role: 'user', content: 'q' }];
  it('omits temperature and reasoning by default', () => {
    expect(buildRequestBody('m/x', msgs)).toEqual({ model: 'm/x', messages: msgs, stream: true, usage: { include: true } });
  });
  it('includes temperature 0 when set (0 is not "unset")', () => {
    expect(buildRequestBody('m/x', msgs, { temperature: 0, effort: 'off' })).toMatchObject({ temperature: 0 });
  });
  it('includes reasoning effort when not off', () => {
    const b = buildRequestBody('m/x', msgs, { temperature: null, effort: 'high' });
    expect(b).toMatchObject({ reasoning: { effort: 'high' } });
    expect(b).not.toHaveProperty('temperature');
  });
});

describe('toRunParams', () => {
  it('empty temperature means null (omit)', () => {
    expect(toRunParams({ temperature: '', effort: 'off' })).toEqual({ temperature: null, effort: 'off' });
  });
  it('parses and clamps temperature to [0, 2]', () => {
    expect(toRunParams({ temperature: '0.7', effort: 'low' })).toEqual({ temperature: 0.7, effort: 'low' });
    expect(toRunParams({ temperature: '9', effort: 'off' }).temperature).toBe(2);
    expect(toRunParams({ temperature: '-1', effort: 'off' }).temperature).toBe(0);
  });
  it('non-numeric temperature means null', () => {
    expect(toRunParams({ temperature: 'abc', effort: 'off' }).temperature).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildRequestBody` / `toRunParams` not exported.

- [ ] **Step 3: Implement**

In `src/scripts/fusion.ts`, insert after the `clearModelCache` function (before the Presets section):

```ts
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
```

In `streamCompletion`, add the optional param and use the builder:

```ts
export async function streamCompletion(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void,
  params: RunParams = DEFAULT_RUN_PARAMS
): Promise<StreamResult> {
```

and replace the `body:` line with:

```ts
      body: JSON.stringify(buildRequestBody(model, messages, params)),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/fusion.ts tests/fusion.test.ts
git commit -m "feat: temperature/reasoning-effort request params, applied via buildRequestBody"
```

---

### Task 3: fusion.ts — judge & writer prompts, lenient JSON parse, analysis→markdown; delete `buildFusionPrompt`

**Files:**
- Modify: `src/scripts/fusion.ts`
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: `ModelResponse` from storage.
- Produces (exact names Task 4 calls):
  - `const JUDGE_KEYS = ['consensus','contradictions','partial_coverage','unique_insights','blind_spots'] as const`
  - `interface JudgeAnalysis { consensus: string[]; contradictions: string[]; partial_coverage: string[]; unique_insights: string[]; blind_spots: string[] }`
  - `buildJudgePrompt(userMessage: string, responses: ModelResponse[]): string`
  - `parseJudgeAnalysis(text: string): JudgeAnalysis | null` (null = fall back to raw text)
  - `analysisToMarkdown(a: JudgeAnalysis): string` (bold section titles + `- ` bullets; empty sections skipped)
  - `buildWriterPrompt(userMessage: string, analysisText: string): string`
- Removes: `buildFusionPrompt` (and its test). `index.astro` does not import it — safe.

- [ ] **Step 1: Write the failing tests**

In `tests/fusion.test.ts`: delete the whole `describe('buildFusionPrompt', …)` block and remove `buildFusionPrompt` from the import; add `buildJudgePrompt, buildWriterPrompt, parseJudgeAnalysis, analysisToMarkdown` to the import; append:

```ts
describe('buildJudgePrompt', () => {
  it('demands the five JSON keys and includes numbered responses with truncation notes', () => {
    const p = buildJudgePrompt('the question', [ok1, truncated]);
    for (const k of ['"consensus"', '"contradictions"', '"partial_coverage"', '"unique_insights"', '"blind_spots"']) {
      expect(p).toContain(k);
    }
    expect(p).toContain('## User Question\nthe question');
    expect(p).toContain('### Response 1 (a/one)\nAnswer one');
    expect(p).toContain('### Response 2 (c/three) (cut off mid-generation)\nCut off answ');
  });
});

describe('parseJudgeAnalysis', () => {
  const good = { consensus: ['a'], contradictions: [], partial_coverage: ['b'], unique_insights: [], blind_spots: [] };
  it('parses clean JSON', () => {
    expect(parseJudgeAnalysis(JSON.stringify(good))).toEqual(good);
  });
  it('strips markdown code fences', () => {
    expect(parseJudgeAnalysis('```json\n' + JSON.stringify(good) + '\n```')).toEqual(good);
  });
  it('coerces missing keys to empty arrays', () => {
    expect(parseJudgeAnalysis('{"consensus":["x"]}')).toEqual({ consensus: ['x'], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] });
  });
  it('returns null for prose, non-objects, and JSON without any expected key', () => {
    expect(parseJudgeAnalysis('The models mostly agree that…')).toBeNull();
    expect(parseJudgeAnalysis('[1,2]')).toBeNull();
    expect(parseJudgeAnalysis('{"verdict":"fine"}')).toBeNull();
  });
});

describe('analysisToMarkdown', () => {
  it('renders bold section titles with bullets and skips empty sections', () => {
    const md = analysisToMarkdown({ consensus: ['both agree'], contradictions: [], partial_coverage: [], unique_insights: ['only one saw it'], blind_spots: [] });
    expect(md).toBe('**Consensus**\n- both agree\n\n**Unique insights**\n- only one saw it');
  });
});

describe('buildWriterPrompt', () => {
  it('contains the question and the analysis, and never raw panel responses', () => {
    const p = buildWriterPrompt('the question', '**Consensus**\n- both agree');
    expect(p).toContain('## User Question\nthe question');
    expect(p).toContain('## Judge Analysis\n**Consensus**\n- both agree');
    expect(p).not.toContain('### Response 1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — new functions not exported.

- [ ] **Step 3: Implement**

In `src/scripts/fusion.ts`, replace the whole `buildFusionPrompt` function with:

```ts
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
```

Deleting `buildFusionPrompt` breaks the old `runSynthesis` (it calls it). Bridge it now — in `runSynthesis`, replace:

```ts
  const messages = [{ role: 'user', content: buildFusionPrompt(userMessage, decision.responses) }];
```

with:

```ts
  const messages = [{ role: 'user', content: buildJudgePrompt(userMessage, decision.responses) }];
```

(temporary — Task 4 rewrites `runSynthesis` entirely).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/fusion.ts tests/fusion.test.ts
git commit -m "feat: judge/writer prompts, lenient judge-JSON parsing, analysis markdown"
```

---

### Task 4: fusion.ts — two-stage `runSynthesis` (options object) + `runFusion` forwarding

**Files:**
- Modify: `src/scripts/fusion.ts`
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 exports.
- Produces (Tasks 5–6 call these exact shapes):

```ts
export interface SynthesisOutcome {
  fusedContent: string;
  analysisText: string;              // markdown (or raw judge text); '' when skipped or judge failed
  judgeError: string | null;         // set when the judge call failed (writer not attempted)
  result: StreamResult | null;       // writer call result; null when no writer call was made
  skipped: 'all-failed' | 'single' | 'partial-failure' | null;
  model: string | null;
}

export interface SynthesisOptions {
  apiKey: string;
  fusionModel: string;
  models: string[];
  userMessage: string;
  responses: ModelResponse[];
  params?: RunParams;
  existingAnalysis?: string | null;  // reuse stored analysis (writer retry) — no judge re-bill
  onJudgeStart?: () => void;
  onJudgeDone?: (analysisText: string, judgeEntry: LogEntry | null) => void; // entry null when analysis reused
  onChunk: (text: string) => void;
  _stream?: typeof streamCompletion; // test seam
}

export async function runSynthesis(opts: SynthesisOptions): Promise<SynthesisOutcome>
```

- `runFusion(params)` gains `runParams?: RunParams`, `onJudgeStart?`, `onJudgeDone?` keys, forwards them, and passes `runParams` to every panel `streamCompletion`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/fusion.test.ts` (add `runSynthesis` to the fusion import, plus `import type { LogEntry } from '../src/scripts/storage';`):

```ts
describe('runSynthesis (two-stage, DI-mocked stream)', () => {
  const judgeJson = JSON.stringify({ consensus: ['both agree'], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] });

  function fakeStream(judgeContent: string, judgeError: string | null = null) {
    const calls: { model: string; prompt: string }[] = [];
    const fn = (async (_key: string, model: string, messages: { role: string; content: string }[], onChunk: (t: string) => void) => {
      const prompt = messages[0]!.content;
      calls.push({ model, prompt });
      const isWriter = prompt.includes('## Judge Analysis');
      const content = isWriter ? 'fused answer' : judgeContent;
      const error = isWriter ? null : judgeError;
      if (!error) onChunk(content);
      return { ...newStreamResult(), content: error ? '' : content, finishReason: error ? null : 'stop', error };
    }) as any;
    return { fn, calls };
  }

  const base = { apiKey: 'k', fusionModel: 'auto', models: ['a/one', 'b/two'], userMessage: 'q', responses: [ok1, ok2] };

  it('runs judge then writer; writer gets the analysis markdown, not raw responses', async () => {
    const { fn, calls } = fakeStream(judgeJson);
    const events: (LogEntry | null)[] = [];
    const outcome = await runSynthesis({ ...base, onJudgeDone: (_a, e) => events.push(e), onChunk: () => {}, _stream: fn });
    expect(calls.length).toBe(2);
    expect(calls[0]!.model).toBe('a/one'); // auto = first source
    expect(calls[1]!.prompt).toContain('**Consensus**\n- both agree');
    expect(calls[1]!.prompt).not.toContain('Answer one');
    expect(outcome.analysisText).toBe('**Consensus**\n- both agree');
    expect(outcome.fusedContent).toBe('fused answer');
    expect(events[0]!.kind).toBe('judge');
  });

  it('falls back to raw judge text when JSON is malformed — writer still runs', async () => {
    const { fn, calls } = fakeStream('the models broadly agree.');
    const outcome = await runSynthesis({ ...base, onChunk: () => {}, _stream: fn });
    expect(outcome.analysisText).toBe('the models broadly agree.');
    expect(calls[1]!.prompt).toContain('the models broadly agree.');
  });

  it('aborts before the writer when the judge call fails', async () => {
    const { fn, calls } = fakeStream('', '[500] judge died');
    const events: (LogEntry | null)[] = [];
    const outcome = await runSynthesis({ ...base, onJudgeDone: (_a, e) => events.push(e), onChunk: () => {}, _stream: fn });
    expect(calls.length).toBe(1);
    expect(outcome.judgeError).toBe('[500] judge died');
    expect(outcome.result).toBeNull();
    expect(events[0]!.status).toBe('error');
  });

  it('reuses existingAnalysis: single writer call, judge entry is null', async () => {
    const { fn, calls } = fakeStream(judgeJson);
    const events: (LogEntry | null)[] = [];
    const outcome = await runSynthesis({ ...base, existingAnalysis: '**Consensus**\n- stored', onJudgeDone: (_a, e) => events.push(e), onChunk: () => {}, _stream: fn });
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toContain('- stored');
    expect(events.length).toBe(1);
    expect(events[0]).toBeNull(); // no judge entry when analysis is reused
    expect(outcome.fusedContent).toBe('fused answer');
  });

  it('keeps skip semantics: all-failed and single make no calls', async () => {
    const { fn, calls } = fakeStream(judgeJson);
    const allFailed = await runSynthesis({ ...base, responses: [failed], onChunk: () => {}, _stream: fn });
    expect(allFailed.skipped).toBe('all-failed');
    const single = await runSynthesis({ ...base, responses: [ok1, failed], onChunk: () => {}, _stream: fn });
    expect(single.skipped).toBe('single');
    expect(single.fusedContent).toBe('Answer one');
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `runSynthesis` still has the old positional signature / no `analysisText` on outcome.

- [ ] **Step 3: Implement**

In `src/scripts/fusion.ts`, replace the `SynthesisOutcome` interface, `runSynthesis`, and `runFusion` entirely with:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (index.astro is now out of sync with these signatures — that is expected until Task 6; `npm test` does not compile index.astro).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/fusion.ts tests/fusion.test.ts
git commit -m "feat: two-stage judge->writer synthesis pipeline with analysis reuse"
```

---

### Task 5: index.astro — settings fields for temperature/effort + params at every call site

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `Settings` (Task 1), `toRunParams` (Task 2).
- Produces: `#settings-temperature` (number input) and `#settings-effort` (select) in the Settings modal; every `streamCompletion`/`runFusion` call passes `toRunParams(...)`.

- [ ] **Step 1: Add the modal fields**

In the Settings modal markup, insert after the closing `</div>` of the "Default fusion model" block (after line ~255) and before the Theme block:

```html
        <!-- Sampling -->
        <div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Temperature</label>
              <input
                id="settings-temperature"
                type="number" min="0" max="2" step="0.1" placeholder="default"
                class="w-full px-3 py-2.5 bg-gray-50 dark:bg-or-bg border border-gray-200 dark:border-or-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-or-accent text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-or-muted"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Reasoning effort</label>
              <select
                id="settings-effort"
                class="w-full px-3 py-2.5 bg-gray-50 dark:bg-or-bg border border-gray-200 dark:border-or-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-or-accent text-gray-900 dark:text-white"
              >
                <option value="off">Off (default)</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
          <p class="mt-1 text-xs text-gray-400 dark:text-or-muted">Applied to every call — panel models, judge, and writer. Empty / Off = provider default.</p>
        </div>
```

- [ ] **Step 2: Wire load/save**

In the `<script>` section:

Add `toRunParams` to the fusion import (line 298).

Add element refs next to `$settingsFusionModel` (~line 335):

```ts
  const $settingsTemperature = document.getElementById('settings-temperature') as HTMLInputElement;
  const $settingsEffort = document.getElementById('settings-effort') as HTMLSelectElement;
```

In `openSettings()`, after the `$settingsFusionModel.value` line:

```ts
    $settingsTemperature.value = s.temperature;
    $settingsEffort.value = s.effort;
```

In the `btn-save-settings` handler, replace the `saveSettings({ apiKey, fusionModel });` line with:

```ts
    saveSettings({
      apiKey,
      fusionModel,
      temperature: $settingsTemperature.value.trim(),
      effort: $settingsEffort.value as Settings['effort'],
    });
```

- [ ] **Step 3: Pass params at the two direct call sites**

In `streamModelIntoTurn` (~line 616), replace the `streamCompletion(...)` call's argument list:

```ts
    const result = await streamCompletion(apiKey, model, lastMessages!, (chunk) => {
      buffer += chunk;
      upsertResponse(turn, model, { model, content: buffer });
      if (contentEl) contentEl.innerHTML = renderMarkdownLite(buffer) + '<span class="animate-blink">▌</span>';
      throttledPartialSave();
    }, toRunParams(getSettings()));
```

In `sendMessage`'s `runFusion({...})` call, add after the `fusionModel:` line:

```ts
        runParams: toRunParams(settings),
```

(The retry-fusion `runSynthesis` call is rewritten wholesale in Task 6 — leave it untouched here.)

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (unchanged — this task is UI wiring; `astro check` still fails until Task 6+8, per Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: temperature/reasoning-effort settings applied to panel calls"
```

---

### Task 6: index.astro — two-stage pipeline wiring (judge status, analysis render, logging, invalidation)

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `runSynthesis(opts)`, `runFusion` with `onJudgeStart`/`onJudgeDone`/`runParams` (Task 4), `Turn.judgeAnalysis` (Task 1).
- Produces: `analysisBlockHtml(turn: Turn): string` helper; `turn.judgeAnalysis` lifecycle (set on judge success, cleared on any `modelResponses` mutation).

- [ ] **Step 1: Add the analysis block helper**

Insert before `renderFusedResult` (~line 481):

```ts
  function analysisBlockHtml(turn: Turn): string {
    if (!turn.judgeAnalysis) return '';
    return `<div class="mb-3 pb-3 border-b border-or-accent/20">
      <div class="text-[10px] font-semibold text-or-accent uppercase tracking-wider mb-1.5">Judge analysis</div>
      <div class="text-xs opacity-90">${renderMarkdownLite(turn.judgeAnalysis)}</div>
    </div>`;
  }
```

- [ ] **Step 2: Render the analysis above the fused answer**

In `renderFusedResult`, replace the success-branch line `el.innerHTML = note + renderMarkdownLite(turn.fusedResponse);` with:

```ts
        el.innerHTML = note + analysisBlockHtml(turn) + renderMarkdownLite(turn.fusedResponse);
```

- [ ] **Step 3: Wire sendMessage's runFusion call**

In `sendMessage`, inside the `runFusion({...})` argument object, add after `runParams: toRunParams(settings),`:

```ts
        onJudgeStart: () => {
          const el = turnEl.querySelector('[data-fused-content]');
          if (el) el.innerHTML = '<span class="text-xs text-gray-400 dark:text-or-muted">Judging responses…</span> <span class="animate-blink text-or-accent">▌</span>';
        },
        onJudgeDone: (analysisText, judgeEntry) => {
          if (judgeEntry) turn.calls!.push(judgeEntry);
          if (analysisText) turn.judgeAnalysis = analysisText;
          persist('partial');
        },
```

Replace the body of `onFusionChunk` so the analysis stays visible while the writer streams:

```ts
        onFusionChunk: (chunk) => {
          fusionBuffer += chunk;
          turn.fusedResponse = fusionBuffer;
          const el = turnEl.querySelector('[data-fused-content]');
          if (el) el.innerHTML = analysisBlockHtml(turn) + renderMarkdownLite(fusionBuffer) + '<span class="animate-blink text-or-accent">▌</span>';
          throttledPartialSave();
          scrollBottom();
        },
```

In `onFusionDone`, replace the `turn.fusion = {...}` assignment with:

```ts
          turn.fusion = {
            skipped: outcome.skipped,
            finishReason: outcome.result?.finishReason ?? null,
            usage: outcome.result?.usage ?? null,
            error: outcome.result?.error ?? outcome.judgeError ?? null,
          };
```

(the `if (outcome.result && outcome.model)` synthesis-log push stays as is — the judge entry arrives via `onJudgeDone`).

- [ ] **Step 4: Rewrite the retry-fusion handler**

Replace the whole `} else if (retryFusionBtn) { ... }` block (~lines 1089–1118) with:

```ts
      } else if (retryFusionBtn) {
        const fusedEl = turnEl.querySelector('[data-fused-content]');
        if (fusedEl) fusedEl.innerHTML = '<span class="animate-blink text-or-accent">▌</span>';
        let buffer = '';
        const outcome = await runSynthesis({
          apiKey: settings.apiKey,
          fusionModel: $fusionModelSelect.value || settings.fusionModel || 'auto',
          models: activeRun.models,
          userMessage: turn.userMessage,
          responses: turn.modelResponses,
          params: toRunParams(settings),
          existingAnalysis: turn.judgeAnalysis ?? null,
          onJudgeStart: () => {
            if (fusedEl) fusedEl.innerHTML = '<span class="text-xs text-gray-400 dark:text-or-muted">Judging responses…</span> <span class="animate-blink text-or-accent">▌</span>';
          },
          onJudgeDone: (analysisText, judgeEntry) => {
            if (judgeEntry) turn.calls.push(judgeEntry);
            if (analysisText) turn.judgeAnalysis = analysisText;
            persist('partial');
          },
          onChunk: (chunk) => {
            buffer += chunk;
            turn.fusedResponse = buffer;
            if (fusedEl) fusedEl.innerHTML = analysisBlockHtml(turn) + renderMarkdownLite(buffer) + '<span class="animate-blink text-or-accent">▌</span>';
            throttledPartialSave();
          },
        });
        turn.fusedResponse = outcome.fusedContent;
        turn.fusion = {
          skipped: outcome.skipped,
          finishReason: outcome.result?.finishReason ?? null,
          usage: outcome.result?.usage ?? null,
          error: outcome.result?.error ?? outcome.judgeError ?? null,
        };
        if (outcome.result && outcome.model) {
          turn.calls.push(buildLogEntry('synthesis', outcome.model, outcome.result));
        }
        renderFusedResult(turnEl, turn, true);
        persist('complete');
      }
```

- [ ] **Step 5: Invalidate stored analysis when responses change**

Three spots (rule from Global Constraints — mutation of `turn.modelResponses` clears the analysis):

In `streamModelIntoTurn`, after the final `upsertResponse(turn, { ... })` call and before `turn.calls!.push(...)`:

```ts
    turn.judgeAnalysis = undefined; // responses changed — a fresh synthesis must re-judge
```

In the discard handler, after `turn.modelResponses = turn.modelResponses.filter(...)`:

```ts
      turn.judgeAnalysis = undefined; // responses changed — a fresh synthesis must re-judge
```

(`runMissingModels` routes through `streamModelIntoTurn`, so it is already covered.)

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: wire two-stage synthesis into UI (judge status, analysis block, invalidation)"
```

---

### Task 7: fusion.ts — `computePresets`

**Files:**
- Modify: `src/scripts/fusion.ts`
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: `ORModel`.
- Produces (Task 8 uses these exact names):
  - `interface Presets { quality: string[]; budget: string[] }`
  - `computePresets(models: ORModel[]): Presets`

Rules (from spec): quality = top 3 by combined per-token price, tiebreak context length desc; budget = cheapest 3, non-zero price preferred then free, same tiebreak. Diversity: one model per author first (best-ranked per author), fill by overall rank if fewer than 3 authors. Missing pricing = 0; negative (sentinel/alias) prices are unrankable — excluded.

- [ ] **Step 1: Write the failing tests**

Append to `tests/fusion.test.ts` (add `computePresets` to the fusion import):

```ts
describe('computePresets', () => {
  const m = (id: string, prompt: string, completion: string, ctx: number) =>
    ({ id, name: id, pricing: { prompt, completion }, context_length: ctx });

  it('quality = priciest distinct authors; budget = cheapest paid first', () => {
    const models = [
      m('oa/big', '0.00001', '0.00003', 128000),
      m('oa/mini', '0.0000001', '0.0000004', 128000),
      m('ant/flagship', '0.000008', '0.000024', 200000),
      m('goo/pro', '0.000007', '0.000021', 1000000),
      m('goo/flash', '0.0000002', '0.0000006', 1000000),
      m('free/tiny', '0', '0', 8000),
    ];
    const p = computePresets(models);
    expect(p.quality).toEqual(['oa/big', 'ant/flagship', 'goo/pro']);
    expect(p.budget).toEqual(['oa/mini', 'goo/flash', 'ant/flagship']);
  });

  it('fills by rank when fewer than 3 authors exist', () => {
    const models = [m('oa/big', '0.00001', '0.00003', 128000), m('oa/mid', '0.000005', '0.000015', 128000), m('oa/mini', '0.000001', '0.000003', 128000)];
    expect(computePresets(models).quality).toEqual(['oa/big', 'oa/mid', 'oa/mini']);
  });

  it('all-free catalog degrades to context-length ranking (guardrailed accounts)', () => {
    const models = [m('a/s', '0', '0', 8000), m('b/m', '0', '0', 32000), m('c/l', '0', '0', 128000), m('d/xl', '0', '0', 256000)];
    const p = computePresets(models);
    expect(p.quality).toEqual(['d/xl', 'c/l', 'b/m']);
    expect(p.budget).toEqual(['d/xl', 'c/l', 'b/m']);
  });

  it('excludes sentinel-priced alias models and handles missing pricing/context', () => {
    const models = [
      { id: 'router/auto', name: 'auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'x/nopricing', name: 'x' },
      m('y/paid', '0.000001', '0.000002', 4000),
    ];
    const p = computePresets(models as any);
    expect(p.quality).toEqual(['y/paid', 'x/nopricing']);
    expect(p.quality).not.toContain('router/auto');
  });

  it('returns empty presets for an empty catalog', () => {
    expect(computePresets([])).toEqual({ quality: [], budget: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `computePresets` not exported.

- [ ] **Step 3: Implement**

In `src/scripts/fusion.ts`, replace the entire `PRESETS` constant (and its section comment content) with:

```ts
// ─── Presets (computed from the live model list) ─────────────────────────────

export interface Presets {
  quality: string[];
  budget: string[];
}

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
```

NOTE: `PRESETS` is deleted here; `index.astro` still imports it until Task 8 — `npm test` doesn't compile index.astro, so the suite stays green (astro check is gated at Task 8).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/fusion.ts tests/fusion.test.ts
git commit -m "feat: computePresets — quality/budget derived from the live model list"
```

---

### Task 8: index.astro — dynamic presets wiring + `MAX_MODELS = 8`; full gates

**Files:**
- Modify: `src/scripts/fusion.ts` (one constant)
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `computePresets`, `Presets` (Task 7).
- Produces: `export const MAX_MODELS = 8` in fusion.ts. App compiles again — this task ends with the full gate run.

- [ ] **Step 1: Export the cap**

In `src/scripts/fusion.ts`, add directly under the `Presets` interface:

```ts
export const MAX_MODELS = 8; // OpenRouter Fusion allows 1–8 panel models
```

- [ ] **Step 2: Rewire index.astro**

Import line 298: remove `PRESETS`, add `computePresets, MAX_MODELS`; add `Presets` to the type import on line 299:

```ts
  import { fetchModels, runFusion, runSynthesis, streamCompletion, buildMessages, buildLogEntry, formatPricePer1M, computePresets, MAX_MODELS, clearModelCache, toRunParams } from '../scripts/fusion';
  import type { ORModel, Presets } from '../scripts/fusion';
```

State (line 305), replace `let selectedModels: string[] = [...PRESETS.quality];` with:

```ts
  let selectedModels: string[] = [];
  let presets: Presets = { quality: [], budget: [] };
```

`loadModels` — replace entirely:

```ts
  async function loadModels(apiKey: string) {
    try {
      allModels = await fetchModels(apiKey);
      populateFusionModelSelect(allModels);
      presets = computePresets(allModels);
      // Auto-apply quality once models arrive — but never overwrite a non-empty selection
      if (selectedModels.length === 0 && presets.quality.length > 0) {
        selectedModels = [...presets.quality];
        activePreset = 'quality';
        renderPresetTabs('quality');
        renderModelChips();
        if (activeRun) { activeRun.models = [...selectedModels]; saveRun(activeRun); }
        refreshLastTurnControls();
      }
    } catch (err) {
      console.warn('Failed to load models', err);
    }
  }
```

Preset click handler — replace the assignment block inside the `.preset-btn` click listener:

```ts
      const preset = (btn as HTMLElement).getAttribute('data-preset')!;
      // No-op until the live model list has produced presets (fetch pending or failed)
      if (preset === 'quality' && presets.quality.length === 0) return;
      if (preset === 'budget' && presets.budget.length === 0) return;
      activePreset = preset;
      if (preset === 'quality') selectedModels = [...presets.quality];
      else if (preset === 'budget') selectedModels = [...presets.budget];
      // custom: keep current selection
```

`showRun` — models may not be loaded yet when opening a persisted run after reload; add at the end of the function:

```ts
    const s = getSettings();
    if (s.apiKey && allModels.length === 0) loadModels(s.apiKey);
```

Cap: line 782 `if (selectedModels.length >= 4) return;` →

```ts
    if (selectedModels.length >= MAX_MODELS) return;
```

Lines 873–876 →

```ts
    } else if (selectedModels.length < MAX_MODELS) {
      selectedModels.push(id);
    } else {
      return; // at the MAX_MODELS cap
    }
```

- [ ] **Step 3: Full gates**

Run: `npm test` — Expected: PASS (all suites).
Run: `npx astro check` — Expected: 0 errors (pre-existing upstream hints about unused `Turn` import / `currentSettings` are acceptable if still present).
Run: `npm run build` — Expected: build completes.

If `astro check` reports errors in index.astro from Tasks 5–6 wiring (signature drift), fix them now — this is the task where the app must compile clean.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/fusion.ts src/pages/index.astro
git commit -m "feat: dynamic quality/budget presets from live model list; panel cap 8"
```

---

### Task 9: STOP — manual E2E (requires user + real API key in the browser)

Do not start this without the user present. Dev server: `npm run dev` → localhost:4321. API key is already in the MCP-Chrome profile's localStorage; app UI needs 1–2 s after load before clicking (hydration); composer textarea sits at x≈540 (extension toolbar overlays center).

Checklist to verify live (free guardrail models):

- [ ] Happy path, 2 models: both stream → "Judging responses…" appears in the fused card → judge analysis block renders (Consensus/…) → writer streams below it. Call log shows a `judge` entry AND a `synthesis` entry, both with genIds/costs.
- [ ] Settings: set temperature 0 + effort low → devtools Network shows `"temperature":0` and `"reasoning":{"effort":"low"}` in all request bodies (panel + judge + writer); clear both → params absent. Values persist across reload.
- [ ] Writer retry reuses analysis: after a successful fusion, press Re-run synthesis → NO new `judge` log entry, one new `synthesis` entry, same analysis block.
- [ ] Discard a response → analysis block disappears from the fused card; Run synthesis → fresh `judge` entry.
- [ ] Cap: can add up to 8 chips, 9th refused; 5+ cards lay out in the grid.
- [ ] Presets: Quality/Budget tabs fill chips from the live (guardrailed) list — no 404 models; before models load the tabs no-op.
- [ ] Export run (MD) contains `### Judge analysis` and the judge row in the call-log table; partial-failure pause still works (kill one model via a bogus custom id, send → paused, not billed).

---

## Deviations & notes for the reviewer

- Judge uses the SSE streaming path with a no-op `onChunk` — "non-streamed" per spec means "not streamed to the UI"; reusing `streamCompletion` keeps one error/usage/genId pipeline (spec's error-handling section: nothing new).
- `buildFusionPrompt` and its test are deleted (replaced by judge/writer prompts) — the spec supersedes the old single-call prompt.
- Mid-series `astro check` breakage (Tasks 4–7) is deliberate and mirrors the failure-handling plan's convention; Task 8 restores and gates it.

---

# Addendum (approved 2026-07-13): per-fusion overrides — Tasks 10–11

Spec Feature 5. The app compiles clean now, so BOTH tasks run the full gates: `npm test` + `npx astro check` (0 errors) + `npm run build`.

### Task 10: resolveRunParams + FusionRun override fields

**Files:**
- Modify: `src/scripts/storage.ts`
- Modify: `src/scripts/fusion.ts`
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: `toRunParams`, `RunParams` (Task 2).
- Produces (Task 11 uses these exact names):
  - `FusionRun.temperature?: string` and `FusionRun.effort?: 'inherit' | 'off' | 'low' | 'medium' | 'high'` (storage.ts)
  - `interface RunOverrides { temperature?: string; effort?: 'inherit' | 'off' | 'low' | 'medium' | 'high' }` (fusion.ts)
  - `resolveRunParams(run: RunOverrides | null | undefined, settings: { temperature: string; effort: RunParams['effort'] }): RunParams`

- [ ] **Step 1: Write the failing tests**

Append to `tests/fusion.test.ts` (add `resolveRunParams` to the fusion import):

```ts
describe('resolveRunParams', () => {
  const settings = { temperature: '0.5', effort: 'low' as const };
  it('inherits both when run has no overrides', () => {
    expect(resolveRunParams(null, settings)).toEqual({ temperature: 0.5, effort: 'low' });
    expect(resolveRunParams({}, settings)).toEqual({ temperature: 0.5, effort: 'low' });
    expect(resolveRunParams({ temperature: '', effort: 'inherit' }, settings)).toEqual({ temperature: 0.5, effort: 'low' });
  });
  it('run overrides win per-field (temperature 0 is a real override)', () => {
    expect(resolveRunParams({ temperature: '0', effort: 'high' }, settings)).toEqual({ temperature: 0, effort: 'high' });
  });
  it('mixed: one field overrides, the other inherits', () => {
    expect(resolveRunParams({ temperature: '1.2' }, settings)).toEqual({ temperature: 1.2, effort: 'low' });
    expect(resolveRunParams({ effort: 'off' }, settings)).toEqual({ temperature: 0.5, effort: 'off' });
  });
  it('clamps overrides and treats whitespace as inherit', () => {
    expect(resolveRunParams({ temperature: '9' }, settings).temperature).toBe(2);
    expect(resolveRunParams({ temperature: '  ' }, settings).temperature).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `resolveRunParams` not exported.

- [ ] **Step 3: Implement**

In `src/scripts/storage.ts`, add to the `FusionRun` interface after `systemPrompt: string;`:

```ts
  temperature?: string;                                     // per-run override; ''/absent = inherit Settings
  effort?: 'inherit' | 'off' | 'low' | 'medium' | 'high';   // 'inherit'/absent = inherit Settings
```

In `src/scripts/fusion.ts`, add directly under `toRunParams`:

```ts
// Per-run overrides (FusionRun.temperature/effort are structurally compatible)
export interface RunOverrides {
  temperature?: string;
  effort?: 'inherit' | 'off' | 'low' | 'medium' | 'high';
}

export function resolveRunParams(
  run: RunOverrides | null | undefined,
  settings: { temperature: string; effort: RunParams['effort'] }
): RunParams {
  return toRunParams({
    temperature: run?.temperature?.trim() ? run.temperature : settings.temperature,
    effort: run?.effort && run.effort !== 'inherit' ? run.effort : settings.effort,
  });
}
```

- [ ] **Step 4: Run the full gates**

Run: `npm test` — Expected: PASS (66/66: 62 + 4 new).
Run: `npx astro check` — Expected: 0 errors.
Run: `npm run build` — Expected: completes.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/storage.ts src/scripts/fusion.ts tests/fusion.test.ts
git commit -m "feat: per-run temperature/effort override fields + resolveRunParams"
```

### Task 11: Params popup in the run view

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `resolveRunParams` (Task 10), `FusionRun.temperature/effort` (Task 10).
- Produces: `#btn-run-params` button + `#run-params-popup` popover; `effectiveRunParams()` helper replacing all three `toRunParams(...)` call sites.

- [ ] **Step 1: Markup**

In the model-selector bar, insert AFTER the closing `</div>` of the "Fuse with" block (currently line ~152, the div containing `#fusion-model-select`) and before the bar's closing `</div>`:

```html
          <!-- Per-fusion sampling overrides -->
          <div class="relative">
            <button
              id="btn-run-params"
              title="Temperature / reasoning effort for this fusion (defaults from Settings)"
              class="flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-or-border text-gray-500 dark:text-or-muted hover:border-or-accent hover:text-or-accent transition-colors"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 001.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
              </svg>
              Params
            </button>
            <div
              id="run-params-popup"
              class="hidden absolute top-full mt-1 right-0 w-64 bg-white dark:bg-or-card border border-gray-200 dark:border-or-border rounded-xl shadow-xl z-50 p-3 space-y-3"
            >
              <div>
                <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Temperature (this fusion)</label>
                <input
                  id="run-temperature"
                  type="number" min="0" max="2" step="0.1"
                  class="w-full px-2.5 py-1.5 text-xs bg-gray-50 dark:bg-or-bg border border-gray-200 dark:border-or-border rounded-lg focus:outline-none focus:ring-2 focus:ring-or-accent text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-or-muted"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Reasoning effort (this fusion)</label>
                <select
                  id="run-effort"
                  class="w-full px-2.5 py-1.5 text-xs bg-gray-50 dark:bg-or-bg border border-gray-200 dark:border-or-border rounded-lg focus:outline-none focus:ring-2 focus:ring-or-accent text-gray-900 dark:text-white"
                >
                  <option value="inherit">Default (from Settings)</option>
                  <option value="off">Off</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              <p class="text-[11px] text-gray-400 dark:text-or-muted">Empty temperature = Settings default. Applies to panel, judge, and writer calls of this fusion.</p>
            </div>
          </div>
```

- [ ] **Step 2: Script wiring**

Import line: replace `toRunParams` with `resolveRunParams` in the fusion import (index.astro ~line 325) — after this task nothing in index.astro uses `toRunParams`.

Element refs (next to the other refs):

```ts
  const $btnRunParams = document.getElementById('btn-run-params') as HTMLButtonElement;
  const $runParamsPopup = document.getElementById('run-params-popup')!;
  const $runTemperature = document.getElementById('run-temperature') as HTMLInputElement;
  const $runEffort = document.getElementById('run-effort') as HTMLSelectElement;
```

Helper (place near `updateRunAddedMainBtn`):

```ts
  // Per-run overrides win over Settings defaults; empty/inherit falls through
  function effectiveRunParams() {
    return resolveRunParams(activeRun, getSettings());
  }
```

Replace all three call sites:
- `streamModelIntoTurn`: `toRunParams(getSettings())` → `effectiveRunParams()`
- `sendMessage`'s runFusion: `runParams: toRunParams(settings),` → `runParams: effectiveRunParams(),`
- retry-fusion handler: `params: toRunParams(settings),` → `params: effectiveRunParams(),`

Popup toggle + populate placeholder on open (place near the btn-add-model handler):

```ts
  $btnRunParams.addEventListener('click', () => {
    $runTemperature.placeholder = getSettings().temperature || 'default';
    $runParamsPopup.classList.toggle('hidden');
  });
```

Extend the existing document outside-click listener (the one closing `$modelDropdown`) with, after the model-dropdown check:

```ts
    if (!$btnRunParams.contains(t) && !$runParamsPopup.contains(t)) {
      $runParamsPopup.classList.add('hidden');
    }
```

Persist on change (place near the `$systemPrompt` change listener):

```ts
  $runTemperature.addEventListener('change', () => {
    if (!activeRun) return;
    activeRun.temperature = $runTemperature.value.trim();
    saveRun(activeRun);
  });
  $runEffort.addEventListener('change', () => {
    if (!activeRun) return;
    activeRun.effort = $runEffort.value as FusionRun['effort'];
    saveRun(activeRun);
  });
```

Populate in `showRun` (after `$systemPrompt.value = run.systemPrompt;`):

```ts
    $runTemperature.value = run.temperature ?? '';
    $runEffort.value = run.effort ?? 'inherit';
```

Reset in `startNewRun` (after `$systemPrompt.value = '';`):

```ts
    $runTemperature.value = '';
    $runEffort.value = 'inherit';
```

Settings modal helper text: change the Sampling block's `<p>` to:

```html
          <p class="mt-1 text-xs text-gray-400 dark:text-or-muted">Defaults for every call — panel, judge, writer. Override per fusion via the Params button. Empty / Off = provider default.</p>
```

- [ ] **Step 3: Run the full gates**

Run: `npm test` — Expected: PASS (66/66, unchanged from Task 10).
Run: `npx astro check` — Expected: 0 errors (pre-existing hints acceptable).
Run: `npm run build` — Expected: completes.

- [ ] **Step 4: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: per-fusion params popup overriding settings defaults"
```

### Task 9 E2E additions (for the manual session)

- Params popup opens/closes (outside click too), persists across reload, run override visible in request bodies while Settings holds a different default, Default/empty falls back to Settings values, old runs (no override fields) inherit cleanly.
