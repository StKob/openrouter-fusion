# openrouter-fusion: failure-handling patch — design

**Date:** 2026-07-10
**Repo:** local clone of `x3asarc/openrouter-fusion` at `/mnt/disc1/CLAUDE PROJECTS/openrouter-fusion` (origin left pointing at upstream; upstream is dormant, we own this copy)
**Approach:** surgical patch — keep the existing architecture (vanilla TS, one Astro page, static output, localStorage only, no backend, no new runtime deps)

## Why

The app queries 2–4 models in parallel via OpenRouter and synthesizes a fused answer, but has zero failure handling: no retries, no `finish_reason` check (truncated responses silently feed the synthesis), failed/empty responses aren't filtered, mid-stream error objects are swallowed by the chunk parser, and there's no cost visibility. These are exactly the failure modes (hard mid-stream failure, length truncation) that made OpenRouter's official Fusion feature waste money.

## Scope

Four features, all approved:

1. Manual retry buttons (per model card + separate synthesis retry)
2. Truncation detection (`finish_reason`)
3. Synthesis hygiene (exclude failures; skip synthesis when pointless)
4. Per-call cost display (OpenRouter usage accounting)
5. Disk persistence: crash-proof incremental saving + auto-save to a folder + export buttons
6. Per-call log: one metadata entry per completions call (generation ID, timing, tokens, cost, outcome), stored inside the fusion run it belongs to — permanent on disk

**Non-goals:** auto-retry, retrying turns other than the latest, `max_tokens` UI (absent = provider default = maximum), response continuation, backend/proxy of any kind, per-chunk disk writes (disk gets completion-level state only).

## Files touched

| File | Change |
|---|---|
| `src/scripts/fusion.ts` | stream result type, mid-stream error + `finish_reason` + `usage` parsing, synthesis hygiene (~60 lines) |
| `src/scripts/storage.ts` | optional fields on `ModelResponse`/`Turn`; run→Markdown formatter + JSON export helpers; `Turn.calls` log entries |
| `src/scripts/disksave.ts` | new — File System Access folder handle (IndexedDB-persisted) + file writer (~60 lines) |
| `src/pages/index.astro` | retry buttons, status badges, cost footers, retry plumbing, incremental saves, export/auto-save UI |
| `tests/fusion.test.ts` | new — pure-logic tests |
| `package.json` | `vitest` as the one new dev dependency + `test` script |

## Streaming & data

- Request body gains `usage: { include: true }`. OpenRouter then delivers token counts **and USD cost** in the final stream chunk — cost display requires zero extra API calls.
- `streamCompletion` returns `StreamResult { content: string; finishReason: string | null; usage: { promptTokens; completionTokens; cost } | null; error: string | null; genId: string | null; provider: string | null; startedAt: number; durationMs: number }` instead of a bare string. `genId`/`provider` come from the top-level `id`/`provider` fields OpenRouter includes in stream chunks — the generation ID is the primary evidence for billing disputes.
- Chunk-parse loop additionally:
  - treats a top-level `error` key in any parsed chunk as a stream failure (OpenRouter's mid-stream hard-failure format — currently silently swallowed),
  - captures `choices[0].finish_reason` when present,
  - captures `usage` when present (arrives in the final chunk).
- Callback surface shrinks: `onModelDone(model, result: StreamResult)` and `onFusionDone(result)` fire at call end on **every** outcome (success, error, truncation — `result.error`/`result.finishReason` say which); the separate `onError` callbacks are removed. This is what guarantees the call log sees failures, not just successes. `onChunk` callbacks unchanged.
- `ModelResponse` gains optional `finishReason?`, `usage?`, `error?`. Optional ⇒ old localStorage runs stay readable. Usage persists into run history, so past generations keep their cost evidence.

## Retry UX (`index.astro`)

- Page keeps the latest turn's state in memory: the exact `messages` array sent, and the live `ModelResponse[]`.
- **Model retry:** button on error *and* truncated cards. Re-runs `streamCompletion` for that model only with the same messages, replaces that entry, re-renders the card, re-persists the run. Other models are never re-billed.
- **Synthesis retry:** button on the fusion card, shown whenever synthesis didn't complete cleanly — failure, truncation, or skipped (so a successful model retry after an all-failed run can still get a synthesis). Rebuilds the fusion prompt from the *current* card contents (post any model retries) and re-streams only the synthesis.
- Model retry does **not** auto-rerun synthesis; the user triggers synthesis retry when satisfied.

## Synthesis hygiene (`runFusion`)

- Partition results: **ok** = non-empty content and no error. Truncated counts as ok (content exists) but its section in the fusion prompt is labeled "(cut off mid-generation)" so the synthesizer knows.
- Failed/empty responses are excluded from the fusion prompt entirely.
- **0 ok** → skip synthesis, no charge; fusion card shows "all models failed — synthesis skipped (not billed)".
- **1 ok** → that response *becomes* the fused answer; synthesis call skipped, card notes "single response — synthesis skipped".

## Badges & cost display

- Per card: status badge for error / non-`stop` `finish_reason` (raw value shown, e.g. `length`), and a footer like `1,234→567 tok · $0.0042`.
- Turn total (sum of all calls incl. synthesis) shown under the fused answer.

## Error handling summary

| Failure | Current behavior | New behavior |
|---|---|---|
| HTTP error on model call | error text on card, empty string still fed to synthesis | error badge + Retry; excluded from synthesis |
| Mid-stream error object | silently swallowed, partial content treated as success | detected → error badge + Retry, partial content kept visible |
| Truncation (`finish_reason: length`) | invisible | badge + labeled in fusion prompt + Retry offered |
| Synthesis failure | fused answer lost, model responses kept | "Retry synthesis" without re-billing models |
| All models fail | synthesis runs anyway on empty sections (billed) | synthesis skipped, not billed |

## Disk persistence

Today the run is saved to localStorage only once, after the entire turn finishes (`index.astro:677`) — a crash mid-turn loses even the model responses that already completed. Three layers fix this, all funneled through one `persist()` helper in the page:

- **Incremental saving (crash-proofing, always on).** `saveRun` fires after every completion-level event: each model done/error, synthesis done/error/skipped. While streams are in flight, a 2-second throttled save also captures partial text to localStorage. Ceiling: at most the last ~2s of a streaming response can be lost to a crash.
- **Auto-save to folder (Chromium only).** A "Save to folder" button in settings calls `showDirectoryPicker()`; the directory handle persists in IndexedDB (handles can't live in localStorage — this is the one place IndexedDB is required, via the raw API, no dependency). On each completion-level event the active run is rewritten to that folder as one Markdown file per run — `YYYY-MM-DD-<id8>-<title-slug>.md` with every turn's user message, each model response (status, finish_reason, cost), and the fused answer. On page load the handle is re-checked with `queryPermission()`; if the browser demands a fresh gesture, the UI shows a one-click "re-enable disk saves" button. Feature-detected (`'showDirectoryPicker' in window`); hidden in Firefox. Write failures show a non-blocking warning and never interrupt a run.
- **Export buttons (universal fallback).** "Export run" downloads the active run as Markdown; "Export all" downloads the full history as JSON (call logs embedded in each run). Works in every browser, no permissions.

## Per-call log

One metadata entry per chat-completions call — initial models, synthesis, and every retry (the `/models` list fetch is unbilled and not logged). Response content is *not* duplicated into the log; the turn already holds it. Entries live **inside the turn they belong to** (`Turn.calls: LogEntry[]`), so the log rides the existing persistence for free and never ages out separately. Entry shape:

```
{ ts, durationMs, kind: 'model'|'synthesis'|'retry', model, genId, provider,
  status: 'ok'|'error'|'truncated', finishReason, promptTokens,
  completionTokens, cost, error? }
```

- **Collection point:** all calls flow through `streamCompletion`, and every call site receives its `StreamResult` — one `logCall(turn, kind, model, result)` helper in the page appends the entry alongside `persist()`. No call can bypass it.
- **Storage:** wherever the run goes, the log goes — incremental localStorage saves, the run's Markdown file on disk (each turn's section ends with its compact log table: time, kind, model, genId, status, tokens, cost), and "Export all" JSON. No separate log store, file, or export.
- **Permanence:** localStorage keeps the last 50 runs (existing quota-safety cap, unchanged); the auto-save folder is the permanent archive — the app never deletes or rewrites files for runs that aged out of localStorage, and deleting a run in the UI leaves its disk file untouched.
- **No viewer UI** — the run's Markdown file is the viewer.

## Testing

- Stream parsing, response partitioning, fusion-prompt building, and the run→Markdown formatter become pure exported functions.
- One `vitest` file covers: delta/`finish_reason`/`usage`/`id` extraction, mid-stream error objects, SSE line buffering, failed-response exclusion, truncation labeling, all-failed and single-survivor paths, cost formatting, Markdown export shape, log-entry construction + the Markdown log table.
- File System Access plumbing is browser-only and stays untested by vitest; it's covered by the manual E2E pass.
- End-to-end check is manual: `npm run dev` + real key + one deliberately bad model ID alongside good ones.
