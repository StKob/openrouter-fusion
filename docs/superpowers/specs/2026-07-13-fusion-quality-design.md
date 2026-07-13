# Fusion-quality: research-faithful two-stage synthesis, run knobs, panel cap 8, dynamic presets

**Date:** 2026-07-13 · **Branch:** `fusion-quality` · **Status:** approved by user

## Goal

Bring the self-hosted replica as close as practical to OpenRouter's real Fusion pipeline, per their published research:

- Blog: <https://openrouter.ai/blog/announcements/fusion-beats-frontier/>
- Docs: <https://openrouter.ai/docs/guides/features/plugins/fusion>

Research facts this design follows: panel of 1–8 models; a **judge** reads all panel responses and emits structured JSON analysis with five fields (consensus, contradictions, partial coverage, unique insights, blind spots); the calling model then **writes the final answer grounded in that analysis** rather than in any single raw output; ~75% of the measured lift comes from the synthesis step. Temperature and reasoning effort are user-configurable in their UI, not hardcoded.

Current state being replaced: single "synthesize the above" call (`src/scripts/fusion.ts` `buildSynthesisPrompt`), hardcoded stale `PRESETS` (`fusion.ts:45`), panel hard-capped at 4 (`src/pages/index.astro:782`, `:873`), no temperature/effort control anywhere.

## Feature 1 — Two-stage synthesis (judge → writer)

Replaces the single synthesis call. Both stages use the selected fusion model.

**Stage A — judge (non-streamed).** Input: user question + all successful panel responses (with the existing `cut off mid-generation` truncation notes). Prompt demands a JSON object with exactly these keys, each an array of strings:

- `consensus` — points all or most models agree on (higher confidence)
- `contradictions` — where models disagree, and which side is better supported
- `partial_coverage` — points only some models addressed
- `unique_insights` — valuable points contributed by a single model
- `blind_spots` — relevant aspects no model addressed

Parsing is lenient: strip markdown code fences, then `JSON.parse`. **On parse failure the judge's raw text is used as the analysis as-is** — no retry loop, no extra billed call.

**Stage B — writer (streamed, as synthesis is today).** Input: user question + the judge's analysis **only** — not the raw panel responses. This follows the research wording ("grounded in that analysis") and halves the double-billed input tokens. Known reversal path: if fused answers come out thin, add raw responses back to the writer prompt (one-line change, ~2× writer input cost).

**Billing & audit.** Fusion now costs 2 billed calls. The judge gets its own audit-log entry — new log kind `judge` — with genId/cost/duration, alongside the existing synthesis (writer) entry.

**Gating.** Pause-on-partial-failure (fc571d2) gates stage A exactly as it gates synthesis today. `all-failed` / `single` skip semantics unchanged.

**Persistence & retry.** The judge analysis (parsed JSON, or raw text on parse failure) is stored on the turn. Writer retry reuses the stored analysis — no judge re-bill. Judge retry restarts the pipeline (judge, then writer). Reload renders analysis + answer from persistence. MD/JSON exports include the analysis.

**UI.** The fused card renders the analysis as compact markdown sections (the five headings, from parsed JSON converted to markdown; raw-text fallback rendered as-is via `renderMarkdownLite`) above the streamed final answer. Streaming cursor behavior unchanged (writer only).

## Feature 2 — Run settings: temperature + reasoning effort

Two fields in the existing Settings modal, persisted with the other settings:

- **Temperature**: number 0–2; empty = omit the param entirely (provider default).
- **Reasoning effort**: dropdown off/low/medium/high; off = omit the `reasoning: { effort }` param. OpenRouter ignores it on non-reasoning models, so sending it when set is safe.

Applied **globally**: every panel call, the judge, and the writer. `streamCompletion` gains optional temperature/effort params included in the request body only when set. No hardcoded temp-0 judge — deterministic judging is the knob set to 0.

## Feature 3 — Panel cap 4 → 8

Export `const MAX_MODELS = 8` from `fusion.ts`; replace the two hardcoded `4`s (`index.astro:782`, `:873`). Matches OpenRouter's 1–8 limit. Cards already flow in a responsive grid; per-call costs are already visible, so no extra cost guard.

## Feature 4 — Dynamic presets from the live model list

Delete the hardcoded `PRESETS` constant. New pure function `computePresets(models: ORModel[])` in `fusion.ts`:

- **quality** = top 3 by combined per-token price (prompt + completion), tiebreak `context_length` descending, preferring distinct authors for panel diversity.
- **budget** = cheapest 3 (non-zero price preferred, else free), same distinct-author preference.
- Distinct-author rule, precisely: rank all models, take the best-ranked model of each author first; if that yields fewer than 3, fill the remainder by overall rank.
- Missing pricing is treated as 0. Degenerate case accepted: on a free-only guardrailed account all prices are 0, so quality ≈ largest-context free models — still strictly better than hardcoded ids that 404.

Computed once after `fetchModels` succeeds. Preset buttons (`index.astro:746`) read the computed arrays and no-op before models load or if the fetch failed. Initial `selectedModels` (`index.astro:305`) changes from `[...PRESETS.quality]` to the persisted selection if present, else empty; the computed quality preset is auto-applied when models arrive **only if the selection is still empty** (a persisted selection is never overwritten).

## Out of scope

- Panel web tools (`:online` / Exa web_search & web_fetch) and the bash tool — billing and guardrail-model support; `:online` already reachable via custom model id.
- Recursion-protection header — meaningless self-hosted.
- Per-stage temperature/effort split; separate judge vs writer models (both = the fusion model).

## Error handling

Nothing new beyond the above: judge/writer failures use the existing retry/badge path per stage; judge JSON parse failure falls back to raw text; `computePresets` is pure and total on well-formed API data.

## Testing

Unit (extends existing vitest suite):

- Judge JSON parsing: clean JSON, fenced JSON, malformed → raw-text fallback.
- Judge prompt shape (five keys demanded; responses + truncation notes present).
- Writer prompt contains the analysis and not the raw panel responses.
- Temperature/effort included in request body only when set; omitted when empty/off.
- `computePresets`: price ranking, context tiebreak, distinct-author preference, all-free degenerate case, empty list.

Gates: `npm test`, `npx astro check`, `npm run build`. Then manual E2E on localhost:4321: happy path (2 free models → judge log entry + analysis sections + streamed answer), writer retry without judge re-bill, knobs persist across reload, cap-8 selection.
