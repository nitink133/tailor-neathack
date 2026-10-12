# NIT-269 handoff — personalised Tailor agent proof

**Integration update, 2026-10-12.** The authorized five-lane implementation is on the separate `codex/tailor-20261012-integration` branch in `.claude/worktrees/tailor-20261012-integration`, based on verified main `17963acb6f7302384d278835697fefbd3ae6878c`. See [`tailor-20261012-implementation.md`](tailor-20261012-implementation.md) for current behavior, verification, approvals and capture limits. The sections below record the earlier baseline; their test totals, fixed spend reservation, single-demo cookie description and older telemetry details are historical. No push, main merge or deployment was performed. Live model and hosted telemetry verification remain separately approval-gated.

Branch `work/nit-269-build-personalised-tailor-agent-proof`, built on `main` at `bbb2600`. Nothing has been merged into `main` or deployed; both remain approval gates. This document states what works, what is mock-backed, what has not been verified, and what needs explicit approval. Test evidence with exact counts lives in [`nit-269-evidence.md`](nit-269-evidence.md); the seam is documented in [`nit-269-contract.md`](nit-269-contract.md); knowledge provenance in [`nit-269-knowledge-sources.md`](nit-269-knowledge-sources.md).

**Current state (post-review fixes commit following `f326d2d`, 2026-10-12).** `npm run typecheck`, `npm run build` and `npm run doctor:local` pass; `npm test` is **280/280**; `npm run test:ui` (Playwright) is **16/16**. (At `f326d2d` the counts were 253/253 and 15/15.) Older figures elsewhere in these docs (115 tests, 6 browser tests, `smoke:live` 8/8, "eval 21/21", "43 calls / $1.02") are dated historical snapshots, not current results; see [`nit-269-evidence.md`](nit-269-evidence.md). Two dated records, `docs/NIT-265-ui-audit.md` and `docs/nit-269-eval-set.json`, still cite pre-refactor paths (`src/client.ts`, `src/server.ts`, `src/store.ts`, `src/fixtures.ts`, `src/validator.ts`); those paths are historical and were deliberately left as written.

## Code layout

The agent loop is a reusable core with a product adapter; Neatlogs is the one shipped adapter. Routes, wire shapes, env vars, npm scripts and buyer copy are unchanged by the split.

| Path | Role |
| --- | --- |
| `src/tailor/` | Reusable core: `core.ts` (`createTailorCore(adapter)`, the turn loop), `adapter.ts` (the `ProductAdapter` contract, types only), `contract.ts` (browser-safe limits, chat/turn shapes, provider, knowledge and telemetry seams), `lifecycle.ts`, `spend.ts` (ledger), `anthropic-transport.ts` (generic JSON-schema structured call), `provider-error.ts`, `claims.ts`, small helpers. No Neatlogs, trace, span or scenario vocabulary. |
| `src/clients/neatlogs/` | The Neatlogs adapter (`adapter.ts`, `service.ts`) and everything Neatlogs-shaped: contracts, validator, fixtures, examples, session tools, prompts, explain/answer composition, Anthropic schemas, mock heuristics, knowledge loading, and the browser UI `client.ts`. |
| `src/infrastructure/` | `store.ts` (SQLite), `server.ts` (HTTP), `telemetry.ts` (neatlogs SDK exporter), `config.ts` (env parsing). |
| `src/main.ts` | Composition root: wires config, infrastructure, core plus the Neatlogs adapter, provider and knowledge. |
| `src/agent-contract.ts`, `src/contracts.ts` | Thin re-export **shims** over `src/clients/neatlogs/{agent-contract,contracts}.ts`, kept for ~23 importers including `ui/` and `scripts/`. |
| `dist/clients/neatlogs/client.js` | Browser bundle (`npm run build`, `tsconfig.browser.json`); the server serves it as `/app.js`. |
| `test/architecture.test.ts` | Guards the layering: `src/tailor/**` reaches only itself, telemetry never reaches `clients/`, the browser entry imports no Node/package modules, and `src/tailor/**` contains no trace/span/scenario/neatlogs vocabulary beyond a two-line allowlist. |
| `test/helpers/crm-adapter.ts` | **Test-only** CRM adapter, exercised through the real core `handleTurn` by `test/core-crm-adapter.test.ts` (valid edit, rejection and repair, stale version, save failure, readback failure, invented citation, unpermitted tool). It proves the core is not Neatlogs-specific; it is not a product. |

**Honest limit (deferred).** The core is generic, but the store and the server are still Neatlogs-shaped: `store.ts` persists `DemoSession`/`Dataset`, runs `validateProposal` inside the publish transaction and holds the trace projections; `server.ts` has the trace and scenario routes and is typed against the Neatlogs `AgentService`; `session-tools.ts` depends on the store. Making them adapter-injected (generic session document, adapter-supplied routes) was deferred as a large, behaviour-risky change. The core also still assumes versioned state (integer `version`, optimistic mutations), one action per turn, fixed step names, shared limits, some fixed English buyer copy and English, SaaS-shaped claim filters.

## Run it

```sh
npm ci
npm run dev            # build the browser bundle, then node src/main.ts on http://127.0.0.1:4321
```

`src/main.ts` is the composition root. It reads plain environment variables only and never loads `.env.local`:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4321` | Loopback only. |
| `TAILOR_DATA_PATH` | `.local/tailor.sqlite` | SQLite with WAL; directory created 0700. |
| `TAILOR_PROVIDER` | `mock` | `mock` (offline) or `anthropic` (live; needs `ANTHROPIC_API_KEY` and `TAILOR_LIVE_CAP_USD`, see below). Anything else exits with code 2. |
| `TAILOR_MODEL` / `TAILOR_EFFORT` | `claude-sonnet-5-5` / `medium` | Live mode only. A model without a configured rate entry exits 2 (the cap could not be enforced). Accepted efforts are `low`, `medium`, `high`; `xhigh` and `max` are refused at startup (exit 2) because their output ceiling is not covered. |
| `TAILOR_LIVE_CAP_USD` | unset | Live mode only; required, numeric, 0 < cap ≤ 50, your explicit approval. A medium-effort planning call reserves up to $0.12435 (see Spend guard), so a cap below ~$0.125 refuses every planning call. |
| `TAILOR_SPEND_LEDGER` | `<dir of TAILOR_DATA_PATH>/spend-ledger.json` | Live mode ledger path. Defaults beside the SQLite file, so pointing `TAILOR_DATA_PATH` at a new directory starts a new ledger (and resets the cap) unless this is set explicitly. |
| `TAILOR_TELEMETRY` | `captured` | `disabled` (no-op), `captured` (in-memory, bounded, no network), `neatlogs` (exports via the pinned SDK; exits 2 unless `NEATLOGS_API_KEY` is set in the process environment; `npm run dev` does not load `.env.local`, `dev:live` does). |
| `TAILOR_DEV_KEY` | unset | Enables the `/api/dev/*` inspection routes (header `x-tailor-dev-key`; constant-time comparison). |
| `NEATLOGS_ENDPOINT` | SDK default | Only read in `neatlogs` mode. |

Gates: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:ui` (Playwright starts its own server on port 4322 with a throwaway database).

## What works (verified locally, mock provider)

- A buyer describes the agent they are building in the Neatlogs-styled entry page; one server-side agent interprets the request, proposes a `ScenarioProposal`, deterministic code validates it, publishes the validated dataset (with the story and the run state) in one SQLite transaction, reads it back independently, and the reply cites only spans that exist in the read-back trace. The demo then shows the personalised trace in the list, detail, graph and timeline views.
- Follow-up edits ("Make the retry fail too.") keep the earlier trace, add the new one, and switch the active scenario; the reply explains what changed using the read-back evidence.
- Ambiguous requests get one clarification question with exactly three choices plus free text; choosing one resolves the turn. No company-name questionnaire.
- Explanations of the open trace ("Explain this trace") come from the saved spans, not from the model's memory of what it proposed. The client sends `openTraceId` with every turn made while a trace is open (the composer shows "Asking about: <trace>"); the server checks it belongs to this session's dataset (else 422 `TRACE_NOT_FOUND`, nothing stored), and the explanation targets that trace rather than the active one.
- The provider label is server-owned: `GET /api/execution` (and `execution` on session reads and turn responses) reports mode, provider, model and effort, and the client paints it on every page, new tab and `/entry`. Mock shows "Mock-backed"; live shows "Live model · <model>"; if the endpoint fails the UI says "Provider status unavailable" and never a mock- or live-looking label. Enter sends the message (Shift+Enter inserts a newline). HTTP 5xx and network failures are reported as unconfirmed/not sent; "Nothing was changed" appears only for 4xx rejections.
- Questions about Neatlogs are answered from the versioned records in `knowledge/neatlogs/` (20 records, version `2026-10-11.1`). Official product claims are separated from what this clone can demonstrate. Pricing and plan availability are reported as unknown because they were not verified; hackathon access is not treated as proof of ordinary plan availability. Requests for features outside the records return `unsupported` with the dataset unchanged.
- Hostile input (prompt injection, requests to run code, to read another session, or to change the real Neatlogs project) is refused with the dataset version unchanged. Buyer text is HTML-escaped in the client.
- Sessions: HttpOnly, SameSite cookie bound to one session; 60 minutes idle or 4 hours total, whichever comes first, enforced on the server clock; expiry deletes the content and answers 410; **End demo** deletes immediately, clears the cookie, and leaves a content-free tombstone for 10 minutes; a sweeper runs every 5 minutes. Deletion is immediate at the API level and **physical** (gone from the SQLite file and WAL) at the WAL checkpoint that follows End demo, expiry or a sweep that deleted rows (`secure_delete` plus a best-effort `wal_checkpoint(TRUNCATE)`; if the checkpoint is busy, the next one completes it). Cross-session access answers 404 so existence is not leaked. No returning-buyer recognition.
- Reload restores the conversation from the server. Turns are durable and idempotent (see "Turn durability" below); a second concurrent turn on the same session gets 409 `TURN_IN_FLIGHT`. Conversations are capped at 120 turns and marked truncated rather than silently dropped.
- Save failure reports `save_failed` and says nothing changed only when the authoritative version really is unchanged; readback failure reports `readback_uncertain` and never claims success. Both paths are covered by injected faults.
- Runtime telemetry wraps the pinned Neatlogs SDK (`neatlogs@1.1.28`, `init`/`trace`/`span`/`flush`/`shutdown`, no invented endpoints or attributes). Each turn is a `tailor.turn` `WORKFLOW` trace with child spans for the core's steps (load_context, retrieve_knowledge, model/repair/escalate/explain, validate, tool, save, readback), carrying real latency, an HMAC-derived correlation ID (never the session ID), and allowlisted `tailor.*` attributes. Raw buyer text, cookies, descriptions and model/tool payloads are never attached. Exporter failures are counted, surfaced on `GET /api/dev/telemetry` and never fail a turn. Token usage is recorded only when a provider reports it; nothing is estimated. Details, privacy guarantees and the hosted evidence are in "Runtime telemetry and hosted Neatlogs" below.

## Turn durability

A turn is **not** a single SQLite transaction. It is a durable three-step record in the `turn_runs` table (`running` → `published` → `settled`), keyed by `(session, clientTurnId)` with a request hash:

1. **Begin** (transaction 1): the pending buyer turn and a `running` run (request hash, started version, started time, turn id, execution label).
2. **Publish** (transaction 2): the validated dataset, the story and the run state (`published`, published version) are written together in one transaction. This is the one place "one SQLite transaction" is literally true.
3. **Settle** (transaction 3): the buyer turn's final status, Tailor's turns and the stored response are appended and the run becomes `settled`.

Consequences, all covered by tests (including a real SIGKILL probe):
- A retry of a settled `clientTurnId` replays the stored response with no new version. Replay keeps a ring of the last 16 settled runs per session. The same id with a different body (text, `choiceId` or `openTraceId`) answers 409 `IDEMPOTENCY_MISMATCH`.
- A retry after a crash does **not** re-run the agent: an interrupted `running`/`published` run is settled as `readback_uncertain` (if it published or the version moved) or `provider_unavailable` ("nothing changed, version N is still live"). Before this, the same retry published a second, duplicate trace.
- A live turn in this process is never settled as interrupted (409 `TURN_IN_FLIGHT` instead). The startup sweep (and the periodic sweep) settles non-settled runs older than 300 s (`(3+1)×60 s + 60 s`), so no "Pending" bubble stays forever. Known edge: a turn genuinely running past 300 s could be settled by the periodic sweep while still executing; that is outside today's per-call limits.
- The server downgrades any claim that does not match the authoritative version: a non-`committed` outcome at an advanced version, or a `committed` whose evidence does not match, becomes `readback_uncertain` with uncertain copy.
- Single server process per database only: the in-flight gate is an in-process set, and the spend ledger is last-writer-wins across processes.

### Routes added or changed

| Route | Notes |
| --- | --- |
| `GET /api/execution` | No session needed; `{ execution: { mode, provider, model, effort } }`. |
| `GET /api/dev/telemetry` | Dev key. Returns the telemetry diagnostics (see below). |
| `GET /api/dev/sessions` | Dev key. Now metadata only (id, state, timestamps, versions, counts); no descriptions, transcripts or datasets. |
| `POST /api/sessions/:id/turns` | `TurnRequest` gains optional `openTraceId`; errors 409 `IDEMPOTENCY_MISMATCH`, 422 `TRACE_NOT_FOUND`. |

### Timeouts

Each provider call is owned by the provider: **60 s** per call with an `AbortController` abort and the SDK's own `timeout` set to the same value; SDK `maxRetries` is **0** (Tailor owns retries). The core's per-call backstop is 65 s, and a **90 s turn deadline** bounds all calls in a turn; no call starts with less than 5 s left. A timeout is a `ProviderError('timeout')` marked non-retryable, so timeouts are **not retried within a turn**. A timed-out call settles at its worst-case reservation as unreconciled (see Spend guard).

## Runtime telemetry and hosted Neatlogs

### What a turn exports

One `tailor.turn` trace (`WORKFLOW`) per buyer turn; child spans are the core's own steps in execution order. Attribute keys below omit the `tailor.` prefix.

| Span / event | Attributes (ids, enums, counts, versions only) |
| --- | --- |
| `tailor.turn` (root) | turn_id (keyed hash `t`+16 hex, not the API `turnId`), correlation_id, provider (`tailor-mock` or `anthropic`), provider_mode, adapter_id, knowledge_version, prompt_version, outcome, status, decision, provider_calls, repairs, escalation_count, tool_calls, grounding_drops, evidence_count, reply_chars, total_ms |
| `load_context`, `retrieve_knowledge` | turn_count, version; max_records, record_count, source_ids (public knowledge ids, ≤12) |
| `model` (one per model attempt; `purpose` = plan / repair / escalate / explain — the evidence-explanation call is a `model` span with `purpose=explain`; `explain` is only the read tool's span) | provider, mode, attempt, purpose, model, effort, prompt_caching, attempt_result, latency_ms, stop_reason, request_id, `usage.*` (available, input, output, cache read, cache write, thinking tokens), cost_known, cost_usd, reservation_usd; on error provider_error_kind, retryable, timeout |
| `validate`, `tool`, `save`, `readback` | issue_count/issue_codes; tool_name (resolved against the adapter's declared tool ids in code; anything else is exported as `invalid_name`), permitted, mutates, version_before/after, arg_count, arg_bytes (argument key names and values are never exported), result_state; state, version, evidence_count, evidence_refs (keyed hashes) |
| events | `tailor.validation`, `tailor.commit`, `tailor.tool_refused`, `tailor.response`, plus the older `provider_error`, `provider_latency`, `provider_request_id`, `turn.result` |

`decision` is a ≤240-character trail built only from fixed tokens and declared tool ids, e.g. `plan→publishScenario v2→readback ok→committed` or `plan→invalid_name:not_permitted→refused` (an undeclared tool name chosen by the model is never exported). Every string attribute is either a closed enum or a code-owned id format; UUID-shaped values and free text are rejected and counted in `redactedValues`. A mock turn reports `cost_known=true, cost_usd=0` and `usage.available=false` (unavailable, never zero tokens); a live success carries priced `cost_usd` and the `reservation_usd`; a live timeout carries `cost_known=false`. The prompt version is `neatlogs-prompts-2026-10-12.1`.

### Privacy guarantees (by construction)

- Allowlisted keys only, each with a value validator; anything else is dropped and counted (`droppedAttributes`). Credential-shaped values (Anthropic/OpenAI-style keys, `nl_…`, Slack/GitHub/AWS/Google tokens, JWTs, PEM, bearer/password strings), email addresses and long high-entropy runs are refused even under allowed keys and counted in `redactedValues`.
- The export mask re-applies the same validators (defence in depth).
- Demo product data never leaves: product evidence ids embed the session id, so only keyed-hash refs (`r` + 10 hex) are exported. Trace labels, dataset content, story, buyer text, model payloads and chain-of-thought are never attributes.
- Synthetic payloads are double opt-in (`syntheticPayloads: true`, default off, and a session whose description starts with `SYNTHETIC hosted-verification`), clipped to 1000 characters; `scripts/verify-hosted.ts` does not enable them.
- Telemetry failures never change a turn; `src/tailor/**` sees only the `TurnTelemetry` seam.

### `GET /api/dev/telemetry` (dev key)

Returns `telemetry.diagnostics()`: `mode`, `deliveryState` (`disabled`, `captured`, `unknown` = nothing confirmed yet, `healthy`, `degraded` = delivering again but spans were lost earlier, `failing` = latest export failed and nothing has succeeded since), `exportFailures`, `droppedSteps`, `droppedAttributes`, `droppedSpans`/`droppedExports`, `sdkFailures`, `redactedValues`, `syntheticPayloads`, `endpoint` (origin only), `queued` (null = not inspectable), `exportedSpans` (Tailor spans ended; excludes the SDK's per-trace `neatlogs.trace.complete` marker, which is counted separately as `markerSpans` — the SDK's own failure counter still includes markers), `lastExportError` (class, code, HTTP status; never bodies), `lastSuccessfulExportAt`, and `recentTurns` (last 20: `turnId` → `correlationId` → `traceId` → `turnRef`, status, outcome). `turnId` is the API's `turnId` and `turnRef` is the hashed `tailor.turn_id` that appears on spans, so an operator can go from a turn response to the hosted trace. `flush()` returns `{ok, exported, failed, state, timedOut}` (read `.ok`; it is false while an earlier failure is unresolved). `shutdown()` is bounded (5 s) and writes one summary line in `neatlogs` mode. **SIGKILL or any exit that bypasses `shutdown()` loses the current batch.**

### `scripts/verify-hosted.ts`

A hosted delivery verifier using **SYNTHETIC data and the mock provider only**; it deletes `ANTHROPIC_API_KEY` from its own environment and makes no model call. Not an npm script; run with `node`:

- **Hosted:** `TAILOR_TELEMETRY=neatlogs TAILOR_PROVIDER=mock node --env-file-if-exists=.env.local scripts/verify-hosted.ts --probe-trace=<Doctor probe trace id>`. It refuses unless the telemetry and provider modes are right, the endpoint is the hosted origin, and a key is present. **Identity gate:** it reads the Doctor probe trace back with the same key and refuses (exit 4, nothing sent) unless the trace's `projectId` is the Tailor project `18c4b4b6-0b1e-4d41-9405-7960fc2d0aa8`, and refuses outright for the learning sandbox `a35a7334-258e-441c-b2e1-b8198a263f21`. (The probe's own JSON does not name a project, so the probe trace's read-back project is the identification.) Then it boots the real server on an ephemeral 127.0.0.1 port with a temporary SQLite, runs four SYNTHETIC-labelled turns (clarify, build, explain, one refused), flushes (`flush().ok` must be true), requires one trace id per turn from `/api/dev/telemetry`, and polls the hosted read-back (up to 60 s) until every trace is found with `projectId` equal to the Tailor project; it reports status, span count and span names per trace. Exit 0 = PASS. (The span counts in the table below were compared with a local captured-mode replay by hand; the script does not assert counts.)
- **`--expect-failure`:** fully offline (`env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY`). A fake key and a 127.0.0.1 listener that answers 401; the turn outcome must be unchanged, delivery must be `failing` and `flush().ok` false. Verified PASS on 2026-10-12.

### Hosted evidence (2026-10-12) — MOCK provider, not live Claude

- **Before 2026-10-12** the Tailor project (`18c4b4b6-0b1e-4d41-9405-7960fc2d0aa8`) held exactly two traces (the synthetic `npm run smoke:trace` trace and the SDK Doctor probe, both 2026-10-10) and no `tailor.turn`; every earlier run (mock, Playwright, the live-model session) used `captured` mode, which disables export. The empty-looking project was expected, not an ingestion failure.
- **On 2026-10-12** the scripted-provider hosted verification added one Doctor probe trace and four `tailor.turn` traces. Each read back on the first poll with the right project and status `success`:

| Turn | Outcome | Trace id | Spans |
| --- | --- | --- | --- |
| clarify | clarification | `f3d1bf87fdea29764ed52d69b90c91b0` | 4 |
| build | committed (v3) | `619b9577233632522df8453976e55a57` | 8 |
| explain | answered | `5072378db5a4f502a413dc7ced161213` | 6 |
| refused (injection) | refused | `49b632ab8b2644fb78cae5ac00e5ac16` | 4 |

- **These are MOCK-provider synthetic traces. They are NOT live Claude evidence.** No model call was made, and live-model hosted ingestion remains unverified. The learning sandbox `a35a7334-258e-441c-b2e1-b8198a263f21` received nothing. The dashboard view was not visually checked.
- **Resolved (review R1, 2026-10-12):** `flush()` reported 26 exported spans while the hosted readback and local capture both show 22 (4 + 8 + 6 + 4). Decoding the OTLP payload offline showed the four extra spans are the `neatlogs` SDK's own `neatlogs.trace.complete` marker (`neatlogs.internal: true`), one per trace: it is sent and counted but treated by Neatlogs as a "trace finished" signal rather than stored. Captured mode never emits it (hence 22 locally). No data was lost. `exportedSpans` now excludes markers and `markerSpans` reports them.

## What is mock-backed

- `TAILOR_PROVIDER=mock` is the default and the only provider used by `npm test`, `npm run test:ui` and `npm run dev`. The mock (`src/clients/neatlogs/mock-provider.ts`, over the generic offline shell in `src/tailor/mock-provider.ts`) is heuristic: it recognises a bounded set of domains and failure shapes, so "unfamiliar wording" works to the extent the heuristics cover it. The UI labels this honestly ("Mock-backed" chip; "Mock-backed prototype — no live model yet"), now from the server's `GET /api/execution` on every page. A live run is the separate, approval-gated `npm run dev:live`, and never falls back to the mock.
- Because the provider is mock, model-quality claims (interpretation of arbitrary wording, proposal richness, explanation prose) are **not** verified by the automated suites. Everything deterministic around the model — validation, permissions, schemas, relationships, timing, session ownership, version checks, save/readback, lifecycle, telemetry shape — is verified and is model-free. Live model behaviour was observed once, by hand, on 2026-10-12 (see "Live provider").
- The eval set (`docs/nit-269-eval-set.json`) is a list of requests and expected outcomes. There is **no runnable evaluator** in the repo: `test/qa-contract.test.ts` only checks the file's shape and parts of it are exercised by other tests. The "21/21" in `nit-269-evidence.md` is a historical manual claim from the mock-backed QA pass (2026-10-11, commit `0846722`), not a reproducible result; reproducing it would need an eval runner that does not exist yet.
- The hosted Neatlogs traces from 2026-10-12 (below) came from the mock provider and a SYNTHETIC fixture. They are **not** live Claude evidence.

## Not verified / not run

- **Live Claude behaviour since the review fixes.** Live calls happened once, on 2026-10-12 under an approved $5 cap, **before** the peer-review fixes (provider rewritten to `messages.create`, reservations, effort ceilings, timeouts, durable turns). The post-fix live path is covered only by offline tests (real SDK with scripted `fetch`, fake clients, fault seams); it has not been re-run live. Never observed live: `stop_reason: refusal`, `max_tokens` truncation, 401/403/402, 429, 529, timeouts, a spend-cap trip, and how Anthropic bills aborted requests. No live call is authorised now (see "Needs approval").
- **Hosted ingestion of live Claude turns.** Hosted export was verified only with the mock provider (below). No live-model `tailor.turn` trace exists in any Neatlogs project; the learning sandbox (`a35a7334-258e-441c-b2e1-b8198a263f21`) received nothing. The Neatlogs dashboard was not visually checked.
- **Telemetry span-count discrepancy: explained.** The hosted run's 26 counted vs 22 stored spans are the SDK's per-trace `neatlogs.trace.complete` marker spans (see Runtime telemetry); not data loss.
- **Prompt caching** is not enabled (see "Prompt caching").
- **Entire coverage.** Checkpoint linkage is partial; see `docs/entire-capture-check.md` (dated 2026-10-12 section). The Entire dashboard was not observed.
- **Deployment.** Not attempted; no credentials created or configured.

## Live provider (Anthropic, approval-gated)

The live baseline is implemented and offline-tested; it runs only when you enter the key and approve a cap. Nothing falls back to the mock in live mode. The live path was exercised by hand once on 2026-10-12, **before** the peer-review fixes described below; the fixed path is offline-tested only.

| Setting | Value | Verified against |
| --- | --- | --- |
| Model | `claude-sonnet-5-5` (configurable via `TAILOR_MODEL`) | Anthropic model overview: Claude API id `claude-sonnet-5-5`, $2 / $10 per MTok |
| Thinking | adaptive (`thinking: {type: "adaptive"}`, the model default) | Thinking docs: `disabled` and `enabled/budget_tokens` return 400 on Sonnet 5.5 |
| Effort | `output_config.effort: "medium"` (configurable via `TAILOR_EFFORT`: `low`, `medium`, `high`; `xhigh`/`max` refused at startup) | Effort docs: `medium` is the documented cost step-down from the `high` default |
| Output ceiling | `max_tokens` follows effort: low 4000, medium 8000, high 12000; the reservation is proportional | Thinking tokens count toward `max_tokens`, so the ceiling must cover thinking plus a full proposal |
| Output | structured JSON via `output_config.format` (untransformed `json_schema`), no tools / `tool_choice`. Calls use `client.messages.create` and Tailor parses the first text block itself, so usage is recorded before any parse error and `stop_reason` is read first (the earlier `messages.parse` path threw before `stop_reason`, leaving truncated/refused calls unrecorded) | Structured outputs docs; real-SDK tests with scripted `fetch` (`test/provider-sdk-wire.test.ts`) |
| SDK | `@anthropic-ai/sdk` 0.133.0, exact pin; `maxRetries: 0` | Official TypeScript SDK |

Per turn: one planning call (interpret, choose a supported action, propose a scenario or ask one three-choice clarification) and, after a successful save and read-back, one explanation call that receives only the read-back evidence. Knowledge retrieval, permissions, schema/timing/relationship validation, persistence, version checks and read-back stay in deterministic code; model output is validated structurally and grounded before use. Refusals (`stop_reason: refusal`), truncation (`max_tokens`), malformed output, context-window overflow, 401/403/402, 429, 529, timeouts and network errors are mapped to a `ProviderErrorKind`, recorded in telemetry (`provider_error_kind`, `retryable`, `request_id`) and surfaced to the buyer as a generic "nothing changed" reply. Refuse and unsupported prose passes the same claim filters as answers, so invented prices, plans and capabilities are dropped. Timeouts: see "Timeouts" above (60 s per call, 90 s turn deadline, no in-turn retry of timeouts).

**Where to enter the key (you, not the assistant):** open `.env.local` in the repo root (gitignored, `chmod 600`; create it from `.env.example` if missing) and set `ANTHROPIC_API_KEY=` to a server-side key from the Anthropic Console project `tailor-neathack`, plus `TAILOR_LIVE_CAP_USD=` to the numeric cap you approve. Do not paste the key in chat, a shell `export`, a commit or any log. `npm run env:check` reports only set/missing.

**Spend guard (ledger v2):** `TAILOR_LIVE_CAP_USD` is required in live mode (0 < cap ≤ 50). The guard **reserves** before every call: a worst case (ceil(conversation chars / 3) input tokens + a fixed per-call overhead computed once at provider creation from the wire-format notes and the output schema at chars/3 plus 600 framing tokens, + the call's `max_tokens` allowance, priced at the model's rates) must fit `spent + reserved` under the cap, and the reservation is persisted to the ledger **before** the request is dispatched. After the call, `settle(usage)` replaces the reservation with the provider-reported cost; an HTTP error response that was not billed releases it; a timeout, dropped connection or missing usage keeps the worst case and marks it **unreconciled** (an unaccounted call is never counted as $0). A reservation left pending by a crash still counts against the cap after a restart. Concurrent calls therefore cannot overrun the cap (six concurrent calls on a $0.10 cap previously spent $0.42). If the ledger cannot be written after a paid call the guard sets `degraded` and fails closed. Version-1 ledgers are still read and rewritten as v2 on the next write.

- **Where:** `TAILOR_SPEND_LEDGER`, default `<dir of TAILOR_DATA_PATH>/spend-ledger.json` (so `.local/spend-ledger.json` by default); the startup line prints the path. A new data directory without this variable starts a fresh ledger.
- **Rates:** per model id (`MODEL_RATES`); Sonnet 5.5 is $2 input / $10 output / $0.10 cache read / $2.50 cache write (5-minute) / $4 cache write (1-hour) per MTok. A model without a rate entry is refused at startup. Cache writes are priced at the 1-hour rate because usage does not report the TTL split (conservative); caching is not enabled.
- **Sizing:** at medium effort a planning call reserves 8000 × $10/MTok = $0.08 of output plus the input worst case, i.e. **$0.12435** for a full-size prompt (low $0.08435, high $0.16435; the explanation call $0.04942). A cap below ~$0.125 therefore refuses every medium planning call (`spend_cap`), and a $1 cap allows only about 8 planning calls in flight at once. Review R1 measured the real per-call cost at medium effort at roughly $0.11; the estimate is deliberately conservative (two concurrent calls on a $0.135 cap no longer overshoot).
- **Effort ceilings:** low 4000, medium 8000, high 12000 output tokens; `xhigh` and `max` exit 2 at startup. The explanation call is fixed at 800 output tokens.
- **Scope:** the repaired guard covers every provider call kind: plan, repair, escalate and explain.
- **`GET /api/dev/spend`** (header `x-tailor-dev-key`) returns `available` plus the summary: `calls`, `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadTokens`, `cacheWriteTokens`, `spentUsd`, `capUsd`, `remainingUsd` (= max(0, cap − spent − reserved)), `reservedUsd` (pending reservations), `pendingCalls`, `unreconciledCalls`, `unreconciledUsd` (unreconciled worst case plus pending), `degraded` and the limits. When no live provider is configured it returns `{available:false}`.
- All USD figures are local estimates from reported usage × list rates; **final Anthropic billing is authoritative** and may differ (and the ledger may under-report: aborted requests may be billed in ways the ledger cannot see).

**Prompt caching: deferred, NOT enabled.** No request sets `cache_control`; `prompt_caching=false` is reported on model spans and the historical ledger shows cache 0/0. Token accounting is ready for it: uncached input, cache writes by TTL (5-minute $2.50 and 1-hour $4 per MTok for Sonnet 5.5), cache reads ($0.10 per MTok) and output are all priced and recorded (`cacheReadTokens`, `cacheWriteTokens`). Enabling caching is a separate decision and is not part of this slice.

**Start:** `npm run dev:live` → `http://127.0.0.1:4321` (if 4321 is busy: `PORT=4323 npm run dev:live` → `http://127.0.0.1:4323`). The startup line prints provider, model, effort and cap (never the key). `npm run dev` stays mock-only. `TAILOR_PROVIDER_DEBUG=1` additionally logs one line per HTTP error with the status, request id and mapped error kind only (never the API message or body, which can echo request fragments).

**Historical live run, 2026-10-12** (approved $5 cap; before the peer-review fixes): `npm run smoke:live` 8/8 PASS against `claude-sonnet-5-5` / medium (a dated historical result, not re-run since); details, defects found by the first live calls and provider-reported usage are in `docs/nit-269-evidence.md` §9.3. The authoritative historical ledger (`.local/spend-ledger.json`, v1 format) shows **45 live calls (29 plan, 16 explain), 277,663 input / 50,732 output / 9,525 thinking tokens, cache 0/0, estimated spend $1.062646**. The "43 calls / $1.02" in earlier docs is an older snapshot taken before the last two calls. Observed cost ≈ $0.03 per committed turn, ≈ $0.02 per clarification/unsupported turn (estimates; billing is authoritative). The fixed provider has not been exercised live.

**Manual test checklist (invented buyer data only):**
1. Open `http://127.0.0.1:4321/entry`; the panel shows "Powered by Tailor · synthetic data" and the mode label from the server: "Live model · claude-sonnet-5-5" for a live run (no "Mock-backed" label), or "Mock-backed" for `npm run dev`. If it says "Provider status unavailable", stop and check `GET /api/execution`. Type the message and press **Enter** to send (Shift+Enter inserts a newline).
2. Send: *I'm building a travel-booking agent. Show me a booking API timeout followed by a successful retry.* Expect an applied reply citing a failed `…attempt_1`-style span, "Evidence · v2", and the trace in the list/detail/timeline views.
3. Send: *Make the retry fail too.* Expect version 3, two traces retained, the new active trace with two ERROR spans, and an explanation that names only spans visible in the trace detail. Live turns took 12–20 s in the historical run (planning ≈ 10–15 s, explanation ≈ 3 s); the worst case is bounded by the 90 s turn deadline.
   - Open an older trace from the list and send *Explain this trace*: the composer shows "Asking about: <that trace>" and the reply must describe that trace, not the active one.
4. Reload the page: conversation and version unchanged.
5. Send: *Show me something failing.* Expect one question with exactly three choices and a free-text hint; pick one.
6. Send: *Set up Slack alerts for this project.* Expect an "outside this demo" reply (or a refusal to change real settings) with the version unchanged.
7. Check `GET /api/dev/spend` (or `npm run smoke:live` for the scripted version of steps 2–6; it checks `GET /api/execution` first and refuses to continue if `TAILOR_EXPECT_LIVE=1` and the mode is not live) and compare the estimated USD with the Anthropic Console later. Expect `pendingCalls` 0 once all turns have ended; a non-zero `unreconciledCalls` means a timeout or dropped connection kept a worst-case estimate.

## Needs approval (outstanding)

1. **A fresh, explicit total spending cap before any live Claude call.** Historical caps (the $5 cap used on 2026-10-12) are not authorisation. You enter `ANTHROPIC_API_KEY` in `.env.local` and confirm a numeric `TAILOR_LIVE_CAP_USD`; no paid call happens before both exist (`TAILOR_LIVE_CAP_USD` was unset at the 2026-10-12 review, so `npm run dev:live` refused to start, correctly). The repaired guard covers plan, repair, escalate and explain calls. Size the cap above ~$0.10 per in-flight planning call, and run one session at a time.
2. **`TAILOR_TELEMETRY=neatlogs` for a live run is a separate approval** (external ingestion of live-model telemetry). The 2026-10-12 hosted verification used the mock provider only; it does not cover live turns. Confirm the Tailor project and region and keep the key in the process environment.
3. **No deployment and no merge into `main`.** Both remain approval gates.

## Known limits

- The in-flight lock is per process; running more than one server process against the same SQLite file is not supported (the spend ledger is likewise last-writer-wins across processes).
- SIGKILL (or any exit that bypasses `shutdown()`) loses the current telemetry batch; `captured`/`neatlogs` exporters drain only on graceful shutdown or an explicit flush.
- The store and server are still Neatlogs-shaped (see "Code layout"); only the agent core is generic.
- Model-authored text is claim-filtered (prices, plans, capabilities, invented measures), but live free-text behaviour is unverified after the fixes.
- Knowledge retrieval is keyword-bounded (`KnowledgeIndex.select`), deliberately without a vector store; records are small enough to fit the model context in full.
- Entire capture is partial: only some commits on this branch carry an `Entire-Checkpoint` trailer, and fewer have a checkpoint ref that materialised. See `docs/entire-capture-check.md` (2026-10-12 section) for the exact coverage. Missing refs are a capture gap to report, not something to repair by rewriting history.

## File map

| Area | Files |
| --- | --- |
| Contract | `src/tailor/contract.ts` (generic), `src/clients/neatlogs/agent-contract.ts`, `src/clients/neatlogs/contracts.ts` (Neatlogs shapes; `src/agent-contract.ts` and `src/contracts.ts` are re-export shims), `src/clients/neatlogs/examples/travel-booking.ts`, `docs/nit-269-contract.md` |
| Core | `src/tailor/{core,adapter,lifecycle,spend,anthropic-transport,provider-error,claims,conversation,prompts,text,json,mock-provider}.ts` |
| Neatlogs adapter | `src/clients/neatlogs/{adapter,service,validator,fixtures,session-tools,context,prompts,explain,answer,claims,provider,anthropic-provider,mock-provider,knowledge}.ts` |
| Infrastructure | `src/infrastructure/{store,server,telemetry,config}.ts`, `src/main.ts` (composition root) |
| UI | `src/clients/neatlogs/client.ts` (bundled to `dist/clients/neatlogs/client.js`, served as `/app.js`), `public/style.css` |
| Knowledge | `knowledge/README.md`, `knowledge/neatlogs/*.json`, `src/clients/neatlogs/knowledge.ts` |
| Scripts | `scripts/{fixture,live-smoke,smoke-trace,verify-hosted}.ts` |
| Tests | `test/*.test.ts` (node:test, including `architecture.test.ts` and the test-only `test/helpers/crm-adapter.ts`), `ui/*.spec.ts` (Playwright) |
