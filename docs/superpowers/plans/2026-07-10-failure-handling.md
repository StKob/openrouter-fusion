# Failure Handling + Disk Persistence + Call Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add retry buttons, truncation detection, synthesis hygiene, per-call cost display, crash-proof + disk persistence, and a per-call audit log to the openrouter-fusion Astro app.

**Architecture:** Surgical patch on the existing structure. `fusion.ts` owns API orchestration and becomes a set of small pure functions plus two entry points (`streamCompletion`, `runFusion`/`runSynthesis`); the page (`index.astro`) owns Turn state, persistence, and DOM. New `disksave.ts` isolates the File System Access API. Spec: `docs/superpowers/specs/2026-07-10-failure-handling-design.md`.

**Tech Stack:** Astro 4 (static), vanilla TypeScript, Tailwind 3, vitest (new, dev-only), File System Access API + IndexedDB (browser natives).

## Global Constraints

- No new **runtime** dependencies. Dev-only additions allowed: `vitest`, `@astrojs/check`, `typescript`.
- The API key is sent to `https://openrouter.ai` only. No other network destinations, ever.
- Static output, no backend: everything runs in the browser.
- Old localStorage data must stay readable: every new field on `Turn`/`ModelResponse` is optional.
- Retry applies to the **latest turn only**.
- Disk writes happen on completion-level events only (never per chunk). The app never deletes disk files.
- Node ≥ 18.17 required for build/test (Astro 4 floor).
- **Build-in-flux window:** Tasks 2–7 change library signatures while `index.astro` still uses old ones. Per-task gate for Tasks 2–7 is `npm test`. `npx astro check` and the running app are gates from Task 8 onward. Do not run the dev app between Tasks 5 and 8.
- All work happens in `/mnt/disc1/CLAUDE PROJECTS/openrouter-fusion`. Commit after every task with the exact message given.

---

### Task 1: Test infrastructure + commit docs

**Files:**
- Modify: `package.json`
- Create: `tests/smoke.test.ts` (deleted again in Task 2 — it only proves the runner works)

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` (vitest), `npx astro check` (type gate used from Task 8 on)

- [ ] **Step 1: Verify environment**

Run: `node --version`
Expected: v18.17+ (any v20/v22 fine). If lower, STOP and report.

- [ ] **Step 2: Install dev deps**

Run (in `/mnt/disc1/CLAUDE PROJECTS/openrouter-fusion`):
```bash
npm install -D vitest @astrojs/check typescript
```
Expected: exit 0, `package.json` gains the three devDependencies.

- [ ] **Step 3: Add test script**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run"
```

- [ ] **Step 4: Write smoke test**

Create `tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Verify runner**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 6: Record astro check baseline**

Run: `npx astro check`
Expected: 0 errors (pristine upstream code). If it reports pre-existing errors, record the count in the commit message — later tasks must not increase it.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tests/ docs/
git commit -m "chore: add vitest + astro check, spec and plan docs"
```

---

### Task 2: Stream-parsing core (`StreamResult`, `applyChunk`, `splitSSEBuffer`)

**Files:**
- Modify: `src/scripts/fusion.ts` (add new exports; do not touch `streamCompletion` yet)
- Modify: `src/scripts/storage.ts` (add `Usage` type only)
- Create: `tests/fusion.test.ts`
- Delete: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces (exact, later tasks depend on these):
  - `storage.ts`: `export interface Usage { promptTokens: number; completionTokens: number; cost: number }`
  - `fusion.ts`: `export interface StreamResult { content: string; finishReason: string | null; usage: Usage | null; error: string | null; genId: string | null; provider: string | null; startedAt: number; durationMs: number }`
  - `fusion.ts`: `export function newStreamResult(): StreamResult`
  - `fusion.ts`: `export function applyChunk(acc: StreamResult, data: string): string | null`
  - `fusion.ts`: `export function splitSSEBuffer(buffer: string): { lines: string[]; rest: string }`

- [ ] **Step 1: Write the failing tests**

Create `tests/fusion.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { applyChunk, newStreamResult, splitSSEBuffer } from '../src/scripts/fusion';

describe('applyChunk', () => {
  it('accumulates delta content and returns the delta', () => {
    const acc = newStreamResult();
    const d1 = applyChunk(acc, JSON.stringify({ id: 'gen-abc', provider: 'OpenAI', choices: [{ delta: { content: 'Hel' } }] }));
    const d2 = applyChunk(acc, JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }));
    expect(d1).toBe('Hel');
    expect(d2).toBe('lo');
    expect(acc.content).toBe('Hello');
  });

  it('captures genId and provider from the first chunk that has them', () => {
    const acc = newStreamResult();
    applyChunk(acc, JSON.stringify({ id: 'gen-first', provider: 'Anthropic', choices: [{ delta: { content: 'x' } }] }));
    applyChunk(acc, JSON.stringify({ id: 'gen-second', provider: 'Other', choices: [{ delta: { content: 'y' } }] }));
    expect(acc.genId).toBe('gen-first');
    expect(acc.provider).toBe('Anthropic');
  });

  it('captures finish_reason', () => {
    const acc = newStreamResult();
    applyChunk(acc, JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }));
    expect(acc.finishReason).toBe('length');
  });

  it('maps usage including cost', () => {
    const acc = newStreamResult();
    applyChunk(acc, JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 34, cost: 0.0042 } }));
    expect(acc.usage).toEqual({ promptTokens: 12, completionTokens: 34, cost: 0.0042 });
  });

  it('treats a top-level error object as stream failure', () => {
    const acc = newStreamResult();
    applyChunk(acc, JSON.stringify({ error: { message: 'Provider returned error', code: 502 } }));
    expect(acc.error).toBe('Provider returned error');
  });

  it('treats a top-level error string as stream failure', () => {
    const acc = newStreamResult();
    applyChunk(acc, JSON.stringify({ error: 'boom' }));
    expect(acc.error).toBe('boom');
  });

  it('ignores malformed JSON and [DONE]', () => {
    const acc = newStreamResult();
    expect(applyChunk(acc, 'not json {')).toBeNull();
    expect(applyChunk(acc, '[DONE]')).toBeNull();
    expect(acc.error).toBeNull();
    expect(acc.content).toBe('');
  });
});

describe('splitSSEBuffer', () => {
  it('returns complete lines and keeps the trailing partial', () => {
    const { lines, rest } = splitSSEBuffer('data: a\ndata: b\ndata: par');
    expect(lines).toEqual(['data: a', 'data: b']);
    expect(rest).toBe('data: par');
  });

  it('returns empty rest when buffer ends with newline', () => {
    const { lines, rest } = splitSSEBuffer('data: a\n');
    expect(lines).toEqual(['data: a']);
    expect(rest).toBe('');
  });
});
```

Delete `tests/smoke.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `applyChunk`, `newStreamResult`, `splitSSEBuffer` are not exported.

- [ ] **Step 3: Implement**

In `src/scripts/storage.ts`, add above `ModelResponse` (line 3):
```ts
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cost: number;
}
```

In `src/scripts/fusion.ts`: change line 1 to `import type { Turn, ModelResponse, Usage } from './storage';` and insert after the Presets section (after line 44):
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/fusion.ts src/scripts/storage.ts tests/
git commit -m "feat: stream-parsing core with error/finish_reason/usage/genId capture"
```

---

### Task 3: Rewrite `streamCompletion` + add `buildMessages`

**Files:**
- Modify: `src/scripts/fusion.ts` (replace `streamCompletion`, lines 48–106 of the original)
- Test: `tests/fusion.test.ts` (add `buildMessages` tests; `streamCompletion` itself is network code, covered by E2E in Task 11)

**Interfaces:**
- Consumes: `newStreamResult`, `applyChunk`, `splitSSEBuffer`, `StreamResult` (Task 2)
- Produces:
  - `export async function streamCompletion(apiKey: string, model: string, messages: { role: string; content: string }[], onChunk: (text: string) => void): Promise<StreamResult>` — **never throws**; failures land in `result.error`. Request body includes `usage: { include: true }`.
  - `export function buildMessages(systemPrompt: string, conversationHistory: { role: string; content: string }[], userMessage: string): { role: string; content: string }[]`

- [ ] **Step 1: Write the failing tests**

Add to `tests/fusion.test.ts`:
```ts
import { buildMessages } from '../src/scripts/fusion';

describe('buildMessages', () => {
  it('includes system prompt when present', () => {
    const m = buildMessages('be brief', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 'q');
    expect(m).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'q' },
    ]);
  });

  it('omits system message when prompt is empty', () => {
    const m = buildMessages('', [], 'q');
    expect(m).toEqual([{ role: 'user', content: 'q' }]);
  });
});
```
(Merge the import with the existing `../src/scripts/fusion` import line.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildMessages` not exported.

- [ ] **Step 3: Implement**

In `src/scripts/fusion.ts`, **replace the entire old `streamCompletion` function** (the one taking `onChunk/onDone/onError` callbacks) with:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass. (`index.astro` and `runFusion` still reference the old signature — that is expected until Tasks 5/8; do not run the app.)

- [ ] **Step 5: Commit**

```bash
git add src/scripts/fusion.ts tests/fusion.test.ts
git commit -m "feat: streamCompletion returns StreamResult, requests usage accounting"
```

---

### Task 4: Storage types, `buildLogEntry`, `formatUsage`

**Files:**
- Modify: `src/scripts/storage.ts` (extend `ModelResponse`/`Turn`, add `LogEntry`, `FusionMeta`, `formatUsage`)
- Modify: `src/scripts/fusion.ts` (add `buildLogEntry`)
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: `StreamResult` (Task 2), `Usage` (Task 2)
- Produces:
  - `storage.ts`: `export interface LogEntry { ts: number; durationMs: number; kind: 'model' | 'synthesis' | 'retry'; model: string; genId: string | null; provider: string | null; status: 'ok' | 'error' | 'truncated'; finishReason: string | null; promptTokens: number | null; completionTokens: number | null; cost: number | null; error?: string }`
  - `storage.ts`: `export interface FusionMeta { finishReason?: string | null; usage?: Usage | null; error?: string | null; skipped?: 'all-failed' | 'single' | null }`
  - `storage.ts`: `ModelResponse` gains optional `finishReason?: string | null; usage?: Usage | null; error?: string | null`
  - `storage.ts`: `Turn` gains optional `fusion?: FusionMeta; calls?: LogEntry[]`
  - `storage.ts`: `export function formatUsage(u: Usage | null | undefined): string` — `"1,234→567 tok · $0.0042"`, `''` for null/undefined
  - `fusion.ts`: `export function buildLogEntry(kind: LogEntry['kind'], model: string, r: StreamResult): LogEntry`

- [ ] **Step 1: Write the failing tests**

Add to `tests/fusion.test.ts`:
```ts
import { buildLogEntry } from '../src/scripts/fusion';
import { formatUsage } from '../src/scripts/storage';

describe('buildLogEntry', () => {
  const base = { content: 'x', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 20, cost: 0.003 }, error: null, genId: 'gen-1', provider: 'OpenAI', startedAt: 1000, durationMs: 250 };

  it('maps an ok result', () => {
    expect(buildLogEntry('model', 'openai/gpt-4o', { ...base })).toEqual({
      ts: 1000, durationMs: 250, kind: 'model', model: 'openai/gpt-4o',
      genId: 'gen-1', provider: 'OpenAI', status: 'ok', finishReason: 'stop',
      promptTokens: 10, completionTokens: 20, cost: 0.003,
    });
  });

  it('marks errors and includes the error text', () => {
    const e = buildLogEntry('retry', 'm', { ...base, error: 'boom', usage: null });
    expect(e.status).toBe('error');
    expect(e.error).toBe('boom');
    expect(e.promptTokens).toBeNull();
    expect(e.cost).toBeNull();
  });

  it('marks finish_reason length as truncated', () => {
    expect(buildLogEntry('synthesis', 'm', { ...base, finishReason: 'length' }).status).toBe('truncated');
  });
});

describe('formatUsage', () => {
  it('formats tokens and cost', () => {
    expect(formatUsage({ promptTokens: 1234, completionTokens: 567, cost: 0.0042 })).toBe('1,234→567 tok · $0.0042');
  });
  it('returns empty string for missing usage', () => {
    expect(formatUsage(null)).toBe('');
    expect(formatUsage(undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildLogEntry` / `formatUsage` not exported.

- [ ] **Step 3: Implement**

In `src/scripts/storage.ts`, replace the `ModelResponse` and `Turn` interfaces with:
```ts
export interface ModelResponse {
  model: string;
  content: string;
  finishReason?: string | null;
  usage?: Usage | null;
  error?: string | null;
}

export interface LogEntry {
  ts: number;
  durationMs: number;
  kind: 'model' | 'synthesis' | 'retry';
  model: string;
  genId: string | null;
  provider: string | null;
  status: 'ok' | 'error' | 'truncated';
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  error?: string;
}

export interface FusionMeta {
  finishReason?: string | null;
  usage?: Usage | null;
  error?: string | null;
  skipped?: 'all-failed' | 'single' | null;
}

export interface Turn {
  userMessage: string;
  modelResponses: ModelResponse[];
  fusedResponse: string;
  fusion?: FusionMeta;
  calls?: LogEntry[];
}
```

Add at the end of `storage.ts`:
```ts
export function formatUsage(u: Usage | null | undefined): string {
  if (!u) return '';
  return `${u.promptTokens.toLocaleString('en-US')}→${u.completionTokens.toLocaleString('en-US')} tok · $${u.cost.toFixed(4)}`;
}
```

In `src/scripts/fusion.ts`: change the storage import to `import type { Turn, ModelResponse, Usage, LogEntry } from './storage';` and add after `splitSSEBuffer`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/storage.ts src/scripts/fusion.ts tests/fusion.test.ts
git commit -m "feat: persisted call-log types, buildLogEntry, formatUsage"
```

---

### Task 5: Synthesis hygiene + `runFusion` rewrite

**Files:**
- Modify: `src/scripts/fusion.ts` (replace `buildFusionPrompt` and `runFusion`; add `partitionResponses`, `decideSynthesis`, `runSynthesis`)
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: `streamCompletion` (Task 3), `StreamResult` (Task 2), `ModelResponse` (Task 4)
- Produces:
  - `export function partitionResponses(responses: ModelResponse[]): { ok: ModelResponse[]; failed: ModelResponse[] }` — ok = non-empty trimmed content AND no error
  - `export type SynthesisDecision = { mode: 'run'; responses: ModelResponse[] } | { mode: 'single'; response: ModelResponse } | { mode: 'all-failed' }`
  - `export function decideSynthesis(responses: ModelResponse[]): SynthesisDecision`
  - `export function buildFusionPrompt(userMessage: string, responses: ModelResponse[]): string` — labels `finishReason === 'length'` sections with `(cut off mid-generation)`
  - `export interface SynthesisOutcome { fusedContent: string; result: StreamResult | null; skipped: 'all-failed' | 'single' | null; model: string | null }`
  - `export async function runSynthesis(apiKey: string, fusionModel: string, models: string[], userMessage: string, responses: ModelResponse[], onChunk: (text: string) => void): Promise<SynthesisOutcome>`
  - `export async function runFusion(params: { apiKey: string; models: string[]; messages: { role: string; content: string }[]; userMessage: string; fusionModel: string; onModelChunk: (model: string, chunk: string) => void; onModelDone: (model: string, result: StreamResult) => void; onFusionChunk: (chunk: string) => void; onFusionDone: (outcome: SynthesisOutcome) => void }): Promise<void>` — no longer builds/returns a Turn; the page owns Turn state

- [ ] **Step 1: Write the failing tests**

Add to `tests/fusion.test.ts`:
```ts
import { partitionResponses, decideSynthesis, buildFusionPrompt } from '../src/scripts/fusion';

const ok1 = { model: 'a/one', content: 'Answer one', finishReason: 'stop', error: null };
const ok2 = { model: 'b/two', content: 'Answer two', finishReason: 'stop', error: null };
const truncated = { model: 'c/three', content: 'Cut off answ', finishReason: 'length', error: null };
const failed = { model: 'd/four', content: '', finishReason: null, error: '[500] boom' };
const emptyOk = { model: 'e/five', content: '   ', finishReason: 'stop', error: null };

describe('partitionResponses', () => {
  it('separates ok from failed/empty', () => {
    const { ok, failed: bad } = partitionResponses([ok1, failed, emptyOk, truncated]);
    expect(ok.map((r) => r.model)).toEqual(['a/one', 'c/three']);
    expect(bad.map((r) => r.model)).toEqual(['d/four', 'e/five']);
  });
});

describe('decideSynthesis', () => {
  it('all failed → all-failed', () => {
    expect(decideSynthesis([failed, emptyOk])).toEqual({ mode: 'all-failed' });
  });
  it('single survivor → single with that response', () => {
    expect(decideSynthesis([ok1, failed])).toEqual({ mode: 'single', response: ok1 });
  });
  it('two+ ok → run with only ok responses', () => {
    const d = decideSynthesis([ok1, failed, ok2]);
    expect(d.mode).toBe('run');
    if (d.mode === 'run') expect(d.responses).toEqual([ok1, ok2]);
  });
});

describe('buildFusionPrompt', () => {
  it('numbers responses, includes content, labels truncated ones', () => {
    const p = buildFusionPrompt('the question', [ok1, truncated]);
    expect(p).toContain('## User Question\nthe question');
    expect(p).toContain('### Response 1 (a/one)\nAnswer one');
    expect(p).toContain('### Response 2 (c/three) (cut off mid-generation)\nCut off answ');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `partitionResponses`, `decideSynthesis` not exported; truncation label missing.

- [ ] **Step 3: Implement**

In `src/scripts/fusion.ts`, replace `buildFusionPrompt` and `runFusion` (and add the new functions) so the whole Fusion section reads:
```ts
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
```
The `Turn` import in fusion.ts becomes unused — remove `Turn` from the import line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/fusion.ts tests/fusion.test.ts
git commit -m "feat: synthesis hygiene (exclude failures, skip pointless synthesis), runFusion v2"
```

---

### Task 6: Markdown export + filenames (`runToMarkdown`, `runFilename`, `slugify`)

**Files:**
- Modify: `src/scripts/storage.ts`
- Test: `tests/fusion.test.ts`

**Interfaces:**
- Consumes: `FusionRun`, `Turn`, `LogEntry`, `formatUsage` (Task 4)
- Produces:
  - `export function slugify(s: string): string` — lowercase, non-alphanumerics → `-`, trimmed, max 40 chars, `'untitled'` fallback
  - `export function runFilename(run: FusionRun): string` — `YYYY-MM-DD-<id8>-<slug>.md`
  - `export function runToMarkdown(run: FusionRun): string`

- [ ] **Step 1: Write the failing tests**

Add to `tests/fusion.test.ts`:
```ts
import { slugify, runFilename, runToMarkdown } from '../src/scripts/storage';
import type { FusionRun } from '../src/scripts/storage';

const sampleRun: FusionRun = {
  id: 'abcd1234-9999-4444-8888-121212121212',
  title: 'What is TypeScript?',
  createdAt: new Date('2026-07-10T12:00:00Z').getTime(),
  models: ['a/one', 'b/two'],
  systemPrompt: '',
  turns: [{
    userMessage: 'What is TypeScript?',
    modelResponses: [
      { model: 'a/one', content: 'A typed superset of JS.', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 20, cost: 0.001 }, error: null },
      { model: 'b/two', content: '', finishReason: null, usage: null, error: '[502] provider died' },
    ],
    fusedResponse: 'TypeScript adds types to JavaScript.',
    fusion: { finishReason: 'stop', usage: { promptTokens: 50, completionTokens: 30, cost: 0.002 }, error: null, skipped: null },
    calls: [
      { ts: 1752148800000, durationMs: 900, kind: 'model', model: 'a/one', genId: 'gen-111', provider: 'ProvA', status: 'ok', finishReason: 'stop', promptTokens: 10, completionTokens: 20, cost: 0.001 },
      { ts: 1752148801000, durationMs: 100, kind: 'model', model: 'b/two', genId: null, provider: null, status: 'error', finishReason: null, promptTokens: null, completionTokens: null, cost: null, error: '[502] provider died' },
      { ts: 1752148802000, durationMs: 800, kind: 'synthesis', model: 'a/one', genId: 'gen-333', provider: 'ProvA', status: 'ok', finishReason: 'stop', promptTokens: 50, completionTokens: 30, cost: 0.002 },
    ],
  }],
};

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('What is TypeScript?')).toBe('what-is-typescript');
  });
  it('falls back to untitled', () => {
    expect(slugify('???')).toBe('untitled');
  });
  it('caps length at 40', () => {
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(40);
  });
});

describe('runFilename', () => {
  it('builds date-id8-slug.md', () => {
    expect(runFilename(sampleRun)).toMatch(/^2026-07-10-abcd1234-what-is-typescript\.md$/);
  });
});

describe('runToMarkdown', () => {
  it('contains title, user message, statuses, fused answer, and the log table with genId', () => {
    const md = runToMarkdown(sampleRun);
    expect(md).toContain('# What is TypeScript?');
    expect(md).toContain('### User');
    expect(md).toContain('What is TypeScript?');
    expect(md).toContain('### a/one (ok · 10→20 tok · $0.0010)');
    expect(md).toContain('### b/two (error: [502] provider died)');
    expect(md).toContain('TypeScript adds types to JavaScript.');
    expect(md).toContain('| gen-111 |');
    expect(md).toContain('| synthesis |');
  });

  it('notes skipped synthesis', () => {
    const run = { ...sampleRun, turns: [{ ...sampleRun.turns[0]!, fusion: { skipped: 'all-failed' as const } }] };
    expect(runToMarkdown(run)).toContain('### Fused answer (synthesis skipped: all-failed)');
  });
});
```
Note: `runFilename` uses the run's **local** date. If the test machine's timezone makes `2026-07-10T12:00:00Z` fall on another local date this test would be off — noon UTC is safe for UTC±11, which covers any realistic machine.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `slugify`, `runFilename`, `runToMarkdown` not exported.

- [ ] **Step 3: Implement**

Add at the end of `src/scripts/storage.ts`:
```ts
// ─── Export / disk formats ────────────────────────────────────────────────────

export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'untitled';
}

export function runFilename(run: FusionRun): string {
  const d = new Date(run.createdAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date}-${run.id.slice(0, 8)}-${slugify(run.title)}.md`;
}

export function runToMarkdown(run: FusionRun): string {
  const lines: string[] = [];
  lines.push(`# ${run.title}`, '');
  lines.push(`- **Created:** ${new Date(run.createdAt).toISOString()}`);
  lines.push(`- **Models:** ${run.models.join(', ')}`);
  if (run.systemPrompt) lines.push(`- **System prompt:** ${run.systemPrompt}`);
  lines.push('');
  run.turns.forEach((turn, i) => {
    lines.push(`## Turn ${i + 1}`, '', '### User', '', turn.userMessage, '');
    for (const r of turn.modelResponses) {
      const status = r.error ? `error: ${r.error}` : r.finishReason === 'length' ? 'truncated' : 'ok';
      const usage = formatUsage(r.usage);
      lines.push(`### ${r.model} (${status}${usage ? ` · ${usage}` : ''})`, '', r.content || '_(no content)_', '');
    }
    lines.push(`### Fused answer${turn.fusion?.skipped ? ` (synthesis skipped: ${turn.fusion.skipped})` : ''}`, '');
    lines.push(turn.fusedResponse || '_(none)_', '');
    if (turn.calls?.length) {
      lines.push('#### Call log', '');
      lines.push('| time | kind | model | genId | status | tokens | cost |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const c of turn.calls) {
        const tokens = c.promptTokens != null ? `${c.promptTokens}→${c.completionTokens}` : '';
        const cost = c.cost != null ? `$${c.cost.toFixed(4)}` : '';
        lines.push(`| ${new Date(c.ts).toISOString()} | ${c.kind} | ${c.model} | ${c.genId ?? ''} | ${c.status} | ${tokens} | ${cost} |`);
      }
      lines.push('');
    }
  });
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/storage.ts tests/fusion.test.ts
git commit -m "feat: run→Markdown formatter with per-turn call-log table, run filenames"
```

---

### Task 7: `disksave.ts` (File System Access + IndexedDB handle)

**Files:**
- Create: `src/scripts/disksave.ts`

**Interfaces:**
- Consumes: browser natives only
- Produces:
  - `export function diskSupported(): boolean`
  - `export async function pickFolder(): Promise<void>` — throws `AbortError` if user cancels (caller catches)
  - `export type DiskState = 'ok' | 'prompt' | 'none'`
  - `export async function diskState(): Promise<DiskState>`
  - `export async function reenableDisk(): Promise<boolean>` — must be called from a user gesture
  - `export async function writeRunFile(filename: string, content: string): Promise<void>` — throws on failure

No unit tests: this file is 100% browser API plumbing (vitest node env has no `showDirectoryPicker`/IndexedDB handles). Covered by the manual E2E pass in Task 11.

- [ ] **Step 1: Implement**

Create `src/scripts/disksave.ts`:
```ts
// File System Access API + IndexedDB handle persistence. Chromium-only;
// callers must feature-detect with diskSupported().

const DB_NAME = 'or-fusion-disk';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key: string): Promise<any> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbSet(key: string, value: any): Promise<void> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

export function diskSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickFolder(): Promise<void> {
  const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
  await idbSet('dir', handle);
}

export type DiskState = 'ok' | 'prompt' | 'none';

export async function diskState(): Promise<DiskState> {
  if (!diskSupported()) return 'none';
  const handle = await idbGet('dir').catch(() => null);
  if (!handle) return 'none';
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  return perm === 'granted' ? 'ok' : 'prompt';
}

// Must be called from a user gesture (click handler).
export async function reenableDisk(): Promise<boolean> {
  const handle = await idbGet('dir').catch(() => null);
  if (!handle) return false;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function writeRunFile(filename: string, content: string): Promise<void> {
  const handle = await idbGet('dir');
  if (!handle) throw new Error('no folder selected');
  const file = await handle.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}
```

- [ ] **Step 2: Verify tests still pass**

Run: `npm test`
Expected: all pass (nothing imports disksave yet).

- [ ] **Step 3: Commit**

```bash
git add src/scripts/disksave.ts
git commit -m "feat: File System Access folder persistence (disksave)"
```

---

### Task 8: Page rewrite part 1 — turn ownership, persistence, badges, cost

This task restores a working app. `index.astro`'s script takes over Turn state from `runFusion` and persists incrementally.

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `runFusion` v2, `buildMessages`, `buildLogEntry`, `StreamResult`, `SynthesisOutcome` (fusion.ts); `formatUsage`, `runToMarkdown`, `runFilename` (storage.ts); `diskState`, `writeRunFile` (disksave.ts — `diskActive` stays `false` until Task 10 wires the UI)
- Produces (used by Tasks 9–10, all inside the page script):
  - module state: `let lastMessages: { role: string; content: string }[] | null`, `let diskActive = false`, `let lastPartialSave = 0`
  - `function persist(level: 'partial' | 'complete'): void`
  - `function throttledPartialSave(): void`
  - `function upsertResponse(turn: Turn, model: string, patch: ModelResponse): void`
  - `function respStatus(r: ModelResponse): 'ok' | 'error' | 'truncated'`
  - `function renderModelCardResult(turnEl: HTMLElement, model: string, turn: Turn, isLast: boolean): void` — renders content, badge, usage footer, and (if `isLast` and not ok) a `[data-retry-model]` button
  - `function renderFusedResult(turnEl: HTMLElement, turn: Turn, isLast: boolean): void` — renders fused content / skip notices, badge, usage, `[data-turn-cost]`, and (if `isLast` and fusion not clean) a `[data-retry-fusion]` button
  - `function updateTurnCost(turnEl: HTMLElement, turn: Turn): void`
  - `function showDiskWarning(text: string): void` — **stub in this task** (`console.warn`), replaced by the banner in Task 10

- [ ] **Step 1: Update imports and module state**

Replace lines 271–283 (imports + state) with:
```ts
  import { getSettings, saveSettings, getRuns, saveRun, deleteRun, createRun, formatDate, formatUsage, runToMarkdown, runFilename } from '../scripts/storage';
  import type { FusionRun, Turn, Settings, ModelResponse } from '../scripts/storage';
  import { fetchModels, runFusion, runSynthesis, streamCompletion, buildMessages, buildLogEntry, PRESETS, clearModelCache } from '../scripts/fusion';
  import type { ORModel } from '../scripts/fusion';
  import { initTheme, toggleTheme, applyTheme } from '../scripts/theme';
  import { diskSupported, pickFolder, diskState, reenableDisk, writeRunFile } from '../scripts/disksave';

  // ─── State ────────────────────────────────────────────────────────────────────
  let activeRun: FusionRun | null = null;
  let selectedModels: string[] = [...PRESETS.quality];
  let activePreset: string = 'quality';
  let allModels: ORModel[] = [];
  let isStreaming = false;
  let currentSettings: Settings = getSettings();
  let lastMessages: { role: string; content: string }[] | null = null;
  let diskActive = false;
  let lastPartialSave = 0;
```
(`runSynthesis`, `streamCompletion`, `pickFolder`, `diskSupported`, `reenableDisk` become used in Tasks 9–10; TypeScript's unused-import warnings are acceptable until then.)

- [ ] **Step 2: Add persistence + rendering helpers**

Insert immediately after the element refs block (after line 307, `$settingsFusionModel`):
```ts
  // ─── Persistence ─────────────────────────────────────────────────────────────
  function showDiskWarning(text: string) {
    console.warn(text); // ponytail: replaced by the banner UI in the disk-UI task
  }

  function persist(level: 'partial' | 'complete') {
    if (!activeRun) return;
    saveRun(activeRun);
    if (level === 'complete' && diskActive) {
      writeRunFile(runFilename(activeRun), runToMarkdown(activeRun)).catch((err) => {
        showDiskWarning(`Disk save failed: ${err?.message ?? err}`);
      });
    }
  }

  function throttledPartialSave() {
    const now = Date.now();
    if (now - lastPartialSave < 2000) return;
    lastPartialSave = now;
    persist('partial');
  }

  function upsertResponse(turn: Turn, model: string, patch: ModelResponse) {
    const idx = turn.modelResponses.findIndex((r) => r.model === model);
    if (idx >= 0) turn.modelResponses[idx] = { ...turn.modelResponses[idx], ...patch };
    else turn.modelResponses.push(patch);
  }

  // ─── Result rendering ─────────────────────────────────────────────────────────
  function respStatus(r: ModelResponse): 'ok' | 'error' | 'truncated' {
    return r.error ? 'error' : r.finishReason === 'length' ? 'truncated' : 'ok';
  }

  function statusBadge(status: 'ok' | 'error' | 'truncated', finishReason: string | null | undefined): string {
    if (status === 'error') return `<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-500 font-medium">error</span>`;
    if (status === 'truncated') return `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 font-medium">${escapeHtml(finishReason ?? 'truncated')}</span>`;
    return '';
  }

  function renderModelCardResult(turnEl: HTMLElement, model: string, turn: Turn, isLast: boolean) {
    const r = turn.modelResponses.find((x) => x.model === model);
    if (!r) return;
    const contentEl = turnEl.querySelector(`[data-model-content="${model}"]`);
    if (contentEl) {
      contentEl.innerHTML = r.error
        ? `<span class="text-red-400 text-xs">Error: ${escapeHtml(r.error)}</span>` +
          (r.content ? '<hr class="my-2 opacity-30">' + renderMarkdownLite(r.content) : '')
        : renderMarkdownLite(r.content);
    }
    const footEl = turnEl.querySelector(`[data-model-foot="${model}"]`);
    if (footEl) {
      const status = respStatus(r);
      const retry = isLast && status !== 'ok'
        ? `<button data-retry-model="${model}" class="text-[11px] px-2 py-0.5 rounded border border-or-accent/40 text-or-accent hover:bg-or-accent/10 transition-colors">Retry</button>`
        : '';
      footEl.innerHTML = `
        <div class="flex items-center gap-2">
          ${statusBadge(status, r.finishReason)}
          <span class="text-[10px] text-gray-400 dark:text-or-muted">${formatUsage(r.usage)}</span>
          <span class="ml-auto"></span>
          ${retry}
        </div>`;
    }
    updateTurnCost(turnEl, turn);
  }

  function renderFusedResult(turnEl: HTMLElement, turn: Turn, isLast: boolean) {
    const el = turnEl.querySelector('[data-fused-content]');
    if (el) {
      if (turn.fusion?.error) {
        el.innerHTML = `<span class="text-red-400 text-xs">Fusion error: ${escapeHtml(turn.fusion.error)}</span>`;
      } else if (turn.fusion?.skipped === 'all-failed') {
        el.innerHTML = `<span class="text-amber-500 text-xs">All models failed — synthesis skipped (not billed).</span>`;
      } else {
        const note = turn.fusion?.skipped === 'single'
          ? `<div class="text-[11px] text-gray-400 dark:text-or-muted mb-2">Single successful response — synthesis skipped.</div>`
          : '';
        el.innerHTML = note + renderMarkdownLite(turn.fusedResponse);
      }
    }
    const footEl = turnEl.querySelector('[data-fused-foot]');
    if (footEl) {
      const f = turn.fusion;
      const notClean = !!(f && (f.error || f.finishReason === 'length' || f.skipped));
      const badge = f?.error ? statusBadge('error', null)
        : f?.finishReason === 'length' ? statusBadge('truncated', f.finishReason)
        : '';
      const retry = isLast && notClean
        ? `<button data-retry-fusion class="text-[11px] px-2 py-0.5 rounded border border-or-accent/40 text-or-accent hover:bg-or-accent/10 transition-colors">${f?.skipped ? 'Run synthesis' : 'Retry synthesis'}</button>`
        : '';
      footEl.innerHTML = `
        <div class="flex items-center gap-2">
          ${badge}
          <span class="text-[10px] text-gray-400 dark:text-or-muted">${formatUsage(f?.usage)}</span>
          <span data-turn-cost class="ml-auto text-[10px] text-gray-400 dark:text-or-muted"></span>
          ${retry}
        </div>`;
    }
    updateTurnCost(turnEl, turn);
  }

  function updateTurnCost(turnEl: HTMLElement, turn: Turn) {
    const el = turnEl.querySelector('[data-turn-cost]');
    if (!el) return;
    const total = (turn.calls ?? []).reduce((s, c) => s + (c.cost ?? 0), 0);
    el.textContent = total > 0 ? `turn total $${total.toFixed(4)}` : '';
  }
```

- [ ] **Step 3: Add footer slots to the turn markup**

In `createTurnElement`, add a footer div to each model card — after the `data-model-content` div (original lines 708–711), the card becomes:
```html
            <div
              data-model-content="${m}"
              class="px-3 py-3 text-sm text-gray-800 dark:text-gray-200 leading-relaxed min-h-[60px] prose-sm prose dark:prose-invert max-w-none"
            ><span class="animate-blink">▌</span></div>
            <div data-model-foot="${m}" class="px-3 py-1.5 border-t border-gray-100 dark:border-or-border"></div>
```
And after the `data-fused-content` div (original lines 724–728) — also **remove the `data-buffer=""` attribute** from it:
```html
        <div
          data-fused-content
          class="px-4 py-4 text-sm text-gray-800 dark:text-gray-200 leading-relaxed min-h-[60px] prose-sm prose dark:prose-invert max-w-none"
        ><span class="animate-blink text-or-accent">▌</span></div>
        <div data-fused-foot class="px-4 py-1.5 border-t border-or-accent/20"></div>
```

- [ ] **Step 4: Replace `sendMessage`**

Replace the entire `sendMessage` function (original lines 584–686) with:
```ts
  async function sendMessage() {
    if (isStreaming || !activeRun) return;
    const message = $chatInput.value.trim();
    if (!message) return;

    const settings = getSettings();
    if (!settings.apiKey) {
      openSettings();
      return;
    }

    $chatInput.value = '';
    autoResize($chatInput);
    isStreaming = true;
    $btnSend.disabled = true;

    // Update run title from first message
    if (activeRun.turns.length === 0) {
      activeRun.title = message.slice(0, 60) + (message.length > 60 ? '…' : '');
    }
    if (activeRun.systemPrompt !== $systemPrompt.value) {
      activeRun.systemPrompt = $systemPrompt.value;
    }

    // Build conversation history (flatten prior turns for context)
    const history: { role: string; content: string }[] = [];
    for (const t of activeRun.turns) {
      history.push({ role: 'user', content: t.userMessage });
      if (t.fusedResponse) history.push({ role: 'assistant', content: t.fusedResponse });
    }
    const messages = buildMessages($systemPrompt.value, history, message);
    lastMessages = messages;

    // The page owns the turn: create it up front, pre-seeded per model, persist immediately
    const turnIdx = activeRun.turns.length;
    const turn: Turn = {
      userMessage: message,
      modelResponses: selectedModels.map((m) => ({ model: m, content: '' })),
      fusedResponse: '',
      calls: [],
    };
    activeRun.turns.push(turn);
    persist('partial');
    renderRunList();

    const turnEl = createTurnElement(message, selectedModels, turnIdx);
    $turnsContainer.appendChild(turnEl);
    scrollBottom();

    const modelBuffers: Record<string, string> = {};
    selectedModels.forEach((m) => { modelBuffers[m] = ''; });
    let fusionBuffer = '';

    try {
      await runFusion({
        apiKey: settings.apiKey,
        models: selectedModels,
        messages,
        userMessage: message,
        fusionModel: $fusionModelSelect.value || settings.fusionModel || 'auto',
        onModelChunk: (model, chunk) => {
          modelBuffers[model] += chunk;
          upsertResponse(turn, model, { model, content: modelBuffers[model] });
          const el = turnEl.querySelector(`[data-model-content="${model}"]`);
          if (el) el.innerHTML = renderMarkdownLite(modelBuffers[model]) + '<span class="animate-blink">▌</span>';
          throttledPartialSave();
          scrollBottom();
        },
        onModelDone: (model, result) => {
          upsertResponse(turn, model, {
            model,
            content: result.content,
            finishReason: result.finishReason,
            usage: result.usage,
            error: result.error,
          });
          turn.calls!.push(buildLogEntry('model', model, result));
          renderModelCardResult(turnEl, model, turn, true);
          persist('complete');
        },
        onFusionChunk: (chunk) => {
          fusionBuffer += chunk;
          turn.fusedResponse = fusionBuffer;
          const el = turnEl.querySelector('[data-fused-content]');
          if (el) el.innerHTML = renderMarkdownLite(fusionBuffer) + '<span class="animate-blink text-or-accent">▌</span>';
          throttledPartialSave();
          scrollBottom();
        },
        onFusionDone: (outcome) => {
          turn.fusedResponse = outcome.fusedContent;
          turn.fusion = {
            skipped: outcome.skipped,
            finishReason: outcome.result?.finishReason ?? null,
            usage: outcome.result?.usage ?? null,
            error: outcome.result?.error ?? null,
          };
          if (outcome.result && outcome.model) {
            turn.calls!.push(buildLogEntry('synthesis', outcome.model, outcome.result));
          }
          renderFusedResult(turnEl, turn, true);
          persist('complete');
        },
      });
    } catch (err) {
      console.error('Fusion run error', err);
    } finally {
      isStreaming = false;
      $btnSend.disabled = false;
      scrollBottom();
      renderRunList();
    }
  }
```

- [ ] **Step 5: Replace `renderAllTurns` and the old `onFusionDone` cleanup**

Replace `renderAllTurns` (original lines 734–753) with:
```ts
  function renderAllTurns() {
    $turnsContainer.innerHTML = '';
    if (!activeRun) return;
    const lastIdx = activeRun.turns.length - 1;
    activeRun.turns.forEach((turn, idx) => {
      const models = turn.modelResponses.length > 0
        ? turn.modelResponses.map((r) => r.model)
        : activeRun!.models;
      const el = createTurnElement(turn.userMessage, models, idx);
      models.forEach((m) => renderModelCardResult(el, m, turn, idx === lastIdx));
      renderFusedResult(el, turn, idx === lastIdx);
      $turnsContainer.appendChild(el);
    });
    scrollBottom();
  }
```
Note: retry buttons on the last saved turn render, but Task 9's handler guards on `lastMessages` — after a reload they are inert until a new message is sent. That is the spec's "latest turn only" rule; acceptable.

- [ ] **Step 6: Verify**

Run: `npm test` — all pass.
Run: `npx astro check` — same error count as the Task 1 baseline (imports flagged unused are warnings/hints, not errors).
Run: `npm run build` — exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: page owns turn state; incremental persistence, badges, per-call cost"
```

---

### Task 9: Page rewrite part 2 — retry handlers

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `streamCompletion`, `runSynthesis`, `buildLogEntry` (fusion.ts); `lastMessages`, `upsertResponse`, `renderModelCardResult`, `renderFusedResult`, `persist`, `throttledPartialSave` (Task 8)
- Produces: delegated click handler on `#turns-container` for `[data-retry-model]` / `[data-retry-fusion]`

- [ ] **Step 1: Add the delegated retry handler**

Insert immediately after the `sendMessage` function:
```ts
  // ─── Retries (latest turn only) ───────────────────────────────────────────────
  $turnsContainer.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const retryModelBtn = target.closest('[data-retry-model]') as HTMLElement | null;
    const retryFusionBtn = target.closest('[data-retry-fusion]') as HTMLElement | null;
    if (!retryModelBtn && !retryFusionBtn) return;
    if (isStreaming || !activeRun || !lastMessages || activeRun.turns.length === 0) return;
    const turn = activeRun.turns[activeRun.turns.length - 1]!;
    turn.calls ??= [];
    const turnEl = target.closest('.turn-block') as HTMLElement | null;
    if (!turnEl) return;
    const settings = getSettings();
    if (!settings.apiKey) { openSettings(); return; }

    isStreaming = true;
    $btnSend.disabled = true;
    try {
      if (retryModelBtn) {
        const model = retryModelBtn.getAttribute('data-retry-model')!;
        const contentEl = turnEl.querySelector(`[data-model-content="${model}"]`);
        if (contentEl) contentEl.innerHTML = '<span class="animate-blink">▌</span>';
        let buffer = '';
        const result = await streamCompletion(settings.apiKey, model, lastMessages, (chunk) => {
          buffer += chunk;
          upsertResponse(turn, model, { model, content: buffer });
          if (contentEl) contentEl.innerHTML = renderMarkdownLite(buffer) + '<span class="animate-blink">▌</span>';
          throttledPartialSave();
        });
        upsertResponse(turn, model, {
          model,
          content: result.content,
          finishReason: result.finishReason,
          usage: result.usage,
          error: result.error,
        });
        turn.calls.push(buildLogEntry('retry', model, result));
        renderModelCardResult(turnEl, model, turn, true);
        persist('complete');
      } else if (retryFusionBtn) {
        const fusedEl = turnEl.querySelector('[data-fused-content]');
        if (fusedEl) fusedEl.innerHTML = '<span class="animate-blink text-or-accent">▌</span>';
        let buffer = '';
        const outcome = await runSynthesis(
          settings.apiKey,
          $fusionModelSelect.value || settings.fusionModel || 'auto',
          activeRun.models,
          turn.userMessage,
          turn.modelResponses,
          (chunk) => {
            buffer += chunk;
            turn.fusedResponse = buffer;
            if (fusedEl) fusedEl.innerHTML = renderMarkdownLite(buffer) + '<span class="animate-blink text-or-accent">▌</span>';
            throttledPartialSave();
          }
        );
        turn.fusedResponse = outcome.fusedContent;
        turn.fusion = {
          skipped: outcome.skipped,
          finishReason: outcome.result?.finishReason ?? null,
          usage: outcome.result?.usage ?? null,
          error: outcome.result?.error ?? null,
        };
        if (outcome.result && outcome.model) {
          turn.calls.push(buildLogEntry('synthesis', outcome.model, outcome.result));
        }
        renderFusedResult(turnEl, turn, true);
        persist('complete');
      }
    } finally {
      isStreaming = false;
      $btnSend.disabled = false;
    }
  });
```

- [ ] **Step 2: Verify**

Run: `npm test` — all pass. `npx astro check` — no new errors. `npm run build` — exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: per-model retry and synthesis retry without re-billing"
```

---

### Task 10: Page rewrite part 3 — disk UI, banner, export buttons

**Files:**
- Modify: `src/pages/index.astro` (markup + script)

**Interfaces:**
- Consumes: `diskSupported`, `pickFolder`, `diskState`, `reenableDisk` (disksave.ts); `runToMarkdown`, `runFilename`, `getRuns` (storage.ts); `diskActive`, `showDiskWarning` (Task 8)
- Produces: working `showDiskWarning` (banner), `refreshDiskState()`, settings-modal disk section, export buttons

- [ ] **Step 1: Add the banner markup**

In the `view-run` div, insert between the system-prompt bar (ends line 164) and `turns-container` (line 167):
```html
        <!-- Disk status banner -->
        <div id="disk-banner" class="hidden border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-400">
          <div class="flex items-center gap-3">
            <span id="disk-banner-text"></span>
            <button id="btn-reenable-disk" class="hidden px-2 py-0.5 rounded border border-amber-500/40 hover:bg-amber-500/10 transition-colors">Re-enable</button>
            <button id="btn-dismiss-disk" class="ml-auto hover:opacity-70">✕</button>
          </div>
        </div>
```

- [ ] **Step 2: Add the settings-modal disk section**

In the settings modal, insert after the Theme block (after line 255, before the closing `</div>` of `space-y-5`):
```html
        <!-- Disk saves + export -->
        <div class="border-t border-gray-100 dark:border-or-border pt-4">
          <div class="text-sm font-medium text-gray-700 dark:text-gray-300">Disk saves</div>
          <div id="disk-status" class="text-xs text-gray-400 dark:text-or-muted mt-0.5 mb-2">Off</div>
          <div class="flex gap-2 flex-wrap">
            <button id="btn-pick-folder" class="px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-or-border hover:border-or-accent hover:text-or-accent transition-colors">Choose folder…</button>
            <button id="btn-export-run" class="px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-or-border hover:border-or-accent hover:text-or-accent transition-colors">Export run (MD)</button>
            <button id="btn-export-all" class="px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-or-border hover:border-or-accent hover:text-or-accent transition-colors">Export all (JSON)</button>
          </div>
        </div>
```

- [ ] **Step 3: Replace the `showDiskWarning` stub and wire the UI**

Replace the Task 8 `showDiskWarning` stub with the banner version, and add the disk/export wiring right after the persistence helpers:
```ts
  function showDiskBanner(text: string, reenable: boolean) {
    document.getElementById('disk-banner')!.classList.remove('hidden');
    document.getElementById('disk-banner-text')!.textContent = text;
    document.getElementById('btn-reenable-disk')!.classList.toggle('hidden', !reenable);
  }

  function showDiskWarning(text: string) {
    console.warn(text);
    showDiskBanner(text, false);
  }

  async function refreshDiskState() {
    const status = document.getElementById('disk-status')!;
    if (!diskSupported()) {
      diskActive = false;
      document.getElementById('btn-pick-folder')!.classList.add('hidden');
      status.textContent = 'Not supported in this browser — use the Export buttons.';
      return;
    }
    const state = await diskState();
    diskActive = state === 'ok';
    if (state === 'ok') {
      status.textContent = 'Saving each run to your chosen folder as Markdown.';
    } else if (state === 'prompt') {
      status.textContent = 'Folder chosen, but access needs to be re-enabled.';
      showDiskBanner('Disk saves need to be re-enabled for this session.', true);
    } else {
      status.textContent = 'Off — choose a folder to auto-save runs as Markdown.';
    }
  }

  function download(filename: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById('btn-pick-folder')!.addEventListener('click', async () => {
    try {
      await pickFolder();
      await refreshDiskState();
    } catch { /* user cancelled the picker */ }
  });

  document.getElementById('btn-reenable-disk')!.addEventListener('click', async () => {
    if (await reenableDisk()) {
      document.getElementById('disk-banner')!.classList.add('hidden');
      await refreshDiskState();
    }
  });

  document.getElementById('btn-dismiss-disk')!.addEventListener('click', () => {
    document.getElementById('disk-banner')!.classList.add('hidden');
  });

  document.getElementById('btn-export-run')!.addEventListener('click', () => {
    if (!activeRun) return;
    download(runFilename(activeRun), runToMarkdown(activeRun), 'text/markdown');
  });

  document.getElementById('btn-export-all')!.addEventListener('click', () => {
    download(`fusion-runs-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(getRuns(), null, 2), 'application/json');
  });
```
And add one call at the end of the init section (next to `renderRunList()` at the top of `init`):
```ts
  refreshDiskState();
```

- [ ] **Step 4: Verify**

Run: `npm test` — all pass. `npx astro check` — no new errors (all imports now used). `npm run build` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: disk auto-save UI, re-enable banner, export buttons"
```

---

### Task 11: End-to-end verification (manual, real API key)

**Files:** none (verification only)

Needs the user's OpenRouter API key pasted into the app's settings (never into files). Chromium browser required for the disk part.

- [ ] **Step 1: Start the app**

Run: `npm run dev` → open the printed localhost URL in Chrome.

- [ ] **Step 2: Walk the checklist**

1. **Happy path:** Settings → paste API key. New Fusion, Budget preset, send a short question. Expect: all cards stream, each card gets a `N→M tok · $x` footer, fused answer streams, `turn total $x` appears under it.
2. **Old data compatibility:** if any pre-patch runs exist in the sidebar, open one — content renders, no console errors (footers may be empty; that's correct).
3. **Hard failure + hygiene:** add model id `openai/nonexistent-model-e2e` via Custom (type it in the search box — if the dropdown blocks unknown ids, temporarily add it to `PRESETS.budget`, rebuild, remove after). Send a message. Expect: that card shows an error badge + Retry button; synthesis still runs from the healthy responses; the log (export or disk file) shows the failed call with `status: error` and the synthesis call.
4. **Retry:** click Retry on the failed card (it will fail again — fine: a fresh log entry with `kind: retry` appears). Click "Retry synthesis" if offered; only one new synthesis call is logged, model cards unchanged.
5. **Crash-proofing:** send a message, and mid-stream hit F5. Reopen the run: the turn exists with whatever had streamed by the last throttled save (≤2s loss).
6. **Disk:** Settings → Choose folder → pick an empty test folder. Send a message. Expect a `YYYY-MM-DD-<id8>-<slug>.md` file whose content shows the turn, statuses, costs, and the per-turn call-log table with genIds. Delete the run in the UI — the file must survive.
7. **Re-enable flow:** fully restart Chrome, reopen the app. Expect the amber banner; click Re-enable, approve; send a message; the file updates.
8. **Exports:** "Export run (MD)" and "Export all (JSON)" both download; the JSON contains `calls` arrays.

- [ ] **Step 3: Record results**

Note any checklist deviations. Fix-or-report before final commit.

- [ ] **Step 4: Final verification + commit**

Run: `npm test && npx astro check && npm run build`
Expected: all green.
```bash
git add -A
git commit -m "chore: e2e verification pass for failure-handling patch" --allow-empty
```
