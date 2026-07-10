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
