import { describe, it, expect } from 'vitest';
import { applyChunk, buildLogEntry, formatPricePer1M, buildMessages, newStreamResult, splitSSEBuffer, partitionResponses, decideSynthesis, shouldPauseSynthesis, buildJudgePrompt, buildWriterPrompt, parseJudgeAnalysis, analysisToMarkdown, buildRequestBody, toRunParams, runSynthesis, computePresets } from '../src/scripts/fusion';
import { formatUsage, slugify, runFilename, runToMarkdown, getSettings } from '../src/scripts/storage';
import type { FusionRun, LogEntry } from '../src/scripts/storage';

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

describe('shouldPauseSynthesis', () => {
  it('pauses when there is at least one failure alongside a success', () => {
    expect(shouldPauseSynthesis([ok1, failed])).toBe(true);
  });
  it('does not pause when all succeeded', () => {
    expect(shouldPauseSynthesis([ok1, ok2])).toBe(false);
  });
  it('does not pause when all failed (all-failed skip handles that)', () => {
    expect(shouldPauseSynthesis([failed, emptyOk])).toBe(false);
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

  it('marks truncated responses', () => {
    const run = {
      ...sampleRun,
      turns: [{
        ...sampleRun.turns[0]!,
        modelResponses: [
          { model: 'c/three', content: 'Cut off answ', finishReason: 'length', usage: null, error: null },
        ],
      }],
    };
    expect(runToMarkdown(run)).toContain('### c/three (truncated)');
  });
});

describe('formatPricePer1M', () => {
  it('formats prompt/completion per 1M tokens', () => {
    expect(formatPricePer1M({ prompt: '0.00000014', completion: '0.00000058' })).toBe('$0.14/$0.58 per 1M');
  });
  it('labels zero-priced models as free', () => {
    expect(formatPricePer1M({ prompt: '0', completion: '0' })).toBe('free');
  });
  it('returns empty string when pricing is missing', () => {
    expect(formatPricePer1M(undefined)).toBe('');
  });
  it('trims trailing zeros and handles larger prices', () => {
    expect(formatPricePer1M({ prompt: '0.0000005', completion: '0.0000022' })).toBe('$0.5/$2.2 per 1M');
  });
  it('hides sentinel (negative) pricing used by alias models', () => {
    expect(formatPricePer1M({ prompt: '-1', completion: '-1' })).toBe('');
  });
});

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

describe('runSynthesis (two-stage, DI-mocked stream)', () => {
  const judgeJson = JSON.stringify({ consensus: ['both agree'], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] });

  function fakeStream(judgeContent: string, judgeError: string | null = null) {
    const calls: { model: string; prompt: string; params: any }[] = [];
    const fn = (async (_key: string, model: string, messages: { role: string; content: string }[], onChunk: (t: string) => void, params: any) => {
      const prompt = messages[0]!.content;
      calls.push({ model, prompt, params });
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

  it('forwards params to both judge and writer calls, and defaults when omitted', async () => {
    const { fn, calls } = fakeStream(judgeJson);
    let judgeStarted = false;
    const params = { temperature: 0, effort: 'low' as const };
    await runSynthesis({ ...base, params, onJudgeStart: () => { judgeStarted = true; }, onChunk: () => {}, _stream: fn });
    expect(judgeStarted).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0]!.params).toEqual(params); // judge leg
    expect(calls[1]!.params).toEqual(params); // writer leg

    const { fn: fn2, calls: calls2 } = fakeStream(judgeJson);
    await runSynthesis({ ...base, onChunk: () => {}, _stream: fn2 });
    expect(calls2[0]!.params).toEqual({ temperature: null, effort: 'off' }); // DEFAULT_RUN_PARAMS applied when opts.params omitted
    expect(calls2[1]!.params).toEqual({ temperature: null, effort: 'off' });
  });
});

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
