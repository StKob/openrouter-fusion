# OpenRouter support ticket draft (ready to send; user approval pending)

**Subject:** `GET /api/v1/models/user` does not apply key-assigned guardrail model allowlists (contradicts documented contract)

**Account/setup (happy to share IDs privately):**
- Personal account, workspace **"Free models"**
- Default **Workspace Guardrail** (Active, applies to all keys in the workspace): Access Policy = **"Only Allow"**, explicit model allowlist (67 models, e.g. `tencent/hy3:free`, `poolside/laguna-xs-2.1:free`), Allowed Providers empty (= all)
- Inference API key **"fusion test"** assigned to that workspace/guardrail

**Documented contract:** Your OpenAPI spec and SDK docs describe `GET /api/v1/models/user` as *"List models filtered by user provider preferences, privacy settings, and guardrails"* (openapi.json, operation `models/user`; also the TypeScript SDK `models.listForUser`).

**Observed behavior (2026-07-12, times UTC):**

1. **The listing includes models the key cannot run.** `GET /api/v1/models/user` (authenticated with the "fusion test" key) returned models *not* on the guardrail allowlist, e.g. `~anthropic/claude-haiku-latest` and `~anthropic/claude-sonnet-latest`. Sending `POST /api/v1/chat/completions` with those exact ids and the same key at **12:44:59Z** returned:
   `404 {"error":{"message":"No endpoints available matching your guardrail restrictions and data policy. Configure: https://openrouter.ai/settings/privacy","code":404}}`
   So `models/user` lists models that the router's guardrail enforcement rejects for the same key — the "and guardrails" part of the contract is not honored for key-assigned workspace guardrail model allowlists.

2. **Conversely, allowlisted models were missing from the listing.** With account privacy consents off, guardrail-allowlisted free models (`tencent/hy3:free`, `poolside/laguna-xs-2.1:free`) were absent from `models/user` — understandable — but after enabling *"Free endpoints that may train on request data,"* they still did not appear in fresh `models/user` responses for several minutes (absent ~12:58Z, present ~13:04Z, fresh fetches each time). If there's server-side caching, please document the propagation delay.

3. Once listed, completions on allowlisted models succeed normally — sample generation ids: `gen-1783861282-7QcgDq18SO3MN9FXtZ4P`, `gen-1783861282-yFSHPsmxU6D1xmYEhlqG`, `gen-1783861611-3RSDZUz4MqvfVsrkq7Pr`.

**Impact:** A client application cannot build a truthful model picker for a guardrailed key: the API lists models that always 404 and (transiently) omits models the key is allowed to use. The dashboard's guardrail "eligibility preview" shows the correct set, but there is no API equivalent accessible with an inference key.

**Requests:**
1. Make `models/user` apply key-assigned guardrail model allowlists, matching completion-time enforcement — or correct the documentation and expose the eligibility-preview set via an inference-key endpoint.
2. Document the cache/propagation delay between privacy-setting changes and `models/user` responses.
