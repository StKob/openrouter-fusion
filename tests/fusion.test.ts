import { describe, it, expect } from 'vitest';
import { applyChunk, buildLogEntry, buildMessages, newStreamResult, splitSSEBuffer, partitionResponses, decideSynthesis, buildFusionPrompt } from '../src/scripts/fusion';
import { formatUsage, slugify, runFilename, runToMarkdown } from '../src/scripts/storage';
import type { FusionRun } from '../src/scripts/storage';

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

describe('formatUsage', () => {
  it('formats tokens and cost', () => {
    expect(formatUsage({ promptTokens: 1234, completionTokens: 567, cost: 0.0042 })).toBe('1,234→567 tok · $0.0042');
  });
  it('returns empty string for missing usage', () => {
    expect(formatUsage(null)).toBe('');
    expect(formatUsage(undefined)).toBe('');
  });
});

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
