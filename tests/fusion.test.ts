import { describe, it, expect } from 'vitest';
import { applyChunk, buildLogEntry, buildMessages, newStreamResult, splitSSEBuffer } from '../src/scripts/fusion';
import { formatUsage } from '../src/scripts/storage';

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

describe('formatUsage', () => {
  it('formats tokens and cost', () => {
    expect(formatUsage({ promptTokens: 1234, completionTokens: 567, cost: 0.0042 })).toBe('1,234→567 tok · $0.0042');
  });
  it('returns empty string for missing usage', () => {
    expect(formatUsage(null)).toBe('');
    expect(formatUsage(undefined)).toBe('');
  });
});
