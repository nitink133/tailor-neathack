# Tailor

Tailor is a candidate project for neatHack (October 2026), currently under validation.

NIT-265 added a bounded local Neatlogs replica: landing, a buyer conversation, trace list, span details, tree and timeline. Every new session starts with two deterministic order lookup fixtures.

NIT-269 (this branch) adds a server-side product agent on top: a buyer describes the agent they are building and Tailor proposes, validates, saves and explains a personalised trace set. By default it runs against a **deterministic mock provider** and is labelled "Mock-backed" in the UI. A live Anthropic provider exists but is approval-gated (explicit spending cap required) and never falls back to the mock. See [`docs/nit-269-handoff.md`](docs/nit-269-handoff.md) for what works, what is mock-backed, what has not been verified and what needs approval.

## Code layout

| Path | Role |
| --- | --- |
| `src/tailor/` | Reusable agent core: `core.ts` (`createTailorCore(adapter)`), the `ProductAdapter` contract (`adapter.ts`), browser-safe `contract.ts`, lifecycle, spend ledger, generic Anthropic transport. No Neatlogs vocabulary. |
| `src/clients/neatlogs/` | The Neatlogs adapter plus everything Neatlogs-shaped: contracts, validator, fixtures, prompts, grounding, mock heuristics, knowledge loading and the browser UI (`client.ts`, bundled to `dist/clients/neatlogs/client.js` and served as `/app.js`). |
| `src/infrastructure/` | SQLite `store.ts`, HTTP `server.ts`, `telemetry.ts` (neatlogs SDK exporter), `config.ts`. |
| `src/main.ts` | Composition root. |
| `src/agent-contract.ts`, `src/contracts.ts` | Thin re-export shims over `src/clients/neatlogs/`, kept for existing importers (`ui/`, `scripts/`). |
| `test/architecture.test.ts`, `test/helpers/crm-adapter.ts` | A layering test, and a test-only CRM adapter that runs through the real core to show it is not Neatlogs-specific. |

The split is partial by design: the core is generic, but the store and server are still Neatlogs-shaped (adapter-injected storage and routes are deferred). Details in the handoff's "Code layout".

## Run the replica

Use Node >=26.7.0 and npm >=11.19.0 on the personal Mac.

```sh
npm ci
npx playwright install chromium # once, for browser tests
npm run dev
```

Open http://127.0.0.1:4321. The server binds loopback only. `npm run dev` deliberately does not load `.env.local` or use the Neatlogs or Anthropic keys, and runs the mock provider with `captured` (in-memory) telemetry. Do not mistake the replica fixtures for real Tailor execution telemetry. Live and hosted-telemetry runs are approval-gated: `npm run dev:live` (needs `ANTHROPIC_API_KEY` and `TAILOR_LIVE_CAP_USD` in `.env.local`) and `TAILOR_TELEMETRY=neatlogs` (needs `NEATLOGS_API_KEY` in the process environment); see the handoff and `.env.example`.

For developer inspection and proposal validation, start the server with a local key, then use the same environment in another terminal:

```sh
export TAILOR_DEV_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run dev
# In a terminal with the same TAILOR_DEV_KEY:
npm run fixture -- validate
npm run fixture -- inspect
```

`validate` creates two fictional sessions, rejects a broken parent, verifies unchanged state, publishes a corrected supported fixture at v2, independently reads it back, rejects stale v1 and denies another session's read/write. `inspect` returns saved descriptions, scenario/version and canonical records; it requires the developer key. Never use real buyer input. `TAILOR_URL` selects another loopback port; `PORT` changes the server port; `TAILOR_DATA_PATH` changes the SQLite file (and, unless `TAILOR_SPEND_LEDGER` is set, the live spend ledger's default location).

Data lives in gitignored `.local/tailor.sqlite` with SQLite WAL/SHM sidecars. The directory is private (0700 when created); the persisted signing secret lets the browser's HttpOnly/SameSite cookie survive a server restart. A cookie grants one session only and lives 4 hours. Sessions expire on the server clock after 60 minutes idle or 4 hours total, whichever comes first; any access to an expired session deletes its row (description, conversation and dataset) and answers 410. **End demo** deletes the conversation and dataset immediately and leaves a content-free tombstone (410 `SESSION_ENDED`) for 10 minutes. A sweeper (`startSweeper`, every 5 minutes) and every server start delete expired sessions and old tombstones nobody revisits. Deletion is immediate at the API level and physical (database and WAL) at the WAL checkpoint that follows End demo, expiry or a sweep. Older databases are migrated in place (new `state`, `last_active_at`, `expires_at`, `last_turn` columns, and a `turn_runs` table that replaces the single last-turn record); pre-existing rows get a lifetime derived from their `createdAt`, so week-old NIT-265 sessions are deleted at startup and their seven-day cookies answer 404. To wipe everything manually, with the server stopped:

```sh
rm -f .local/tailor.sqlite .local/tailor.sqlite-wal .local/tailor.sqlite-shm
# Optional browser-test dataset reset, also with its server stopped:
rm -f .local/ui-test.sqlite .local/ui-test.sqlite-wal .local/ui-test.sqlite-shm
```

These commands destroy only the named local fictional datasets and invalidate their cookies; do not point the server at buyer data. They do not touch `.local/spend-ledger.json`. No reset was applied to the primary checkout or another worktree.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:ui
npm run doctor:local
```

As of 2026-10-12 (post-review fixes commit following `f326d2d`): `npm test` 280/280, `npm run test:ui` 16/16, and typecheck, build and `doctor:local` pass (older counts in docs, such as 115 tests, are dated snapshots). There is no lint script. Browser screenshots default to `test-results/evidence`; set `TAILOR_SCREENSHOT_DIR` to a review folder to preserve them. Tests use disposable fictional data, local request interruption/failure simulation and a test-only developer key. The HTTP tests close/reopen the database/server to verify restart persistence, full-document rollback, concurrent CAS conflicts and cross-session denial.

`doctor:probe`, `env:check` and `smoke:trace` retain their existing meanings in AGENTS.md. Authenticated probing and synthetic real trace ingestion were not run for NIT-265 because the real account is read-only for this task; the 2026-10-12 hosted verification (`scripts/verify-hosted.ts`, mock provider, synthetic fixture, four `tailor.turn` traces) is described in the handoff and is not live-model evidence. `neatlogs` remains pinned to 1.1.28. `npm audit` reports 10 moderate and 4 high advisories in its existing SDK/OpenTelemetry/protobuf dependency chain; this slice does not upgrade that integration.

## API contract

Types live in `src/clients/neatlogs/contracts.ts` (re-exported by the `src/contracts.ts` shim); all UI projections originate in the session's single canonical dataset. Cookies and developer keys are never embedded in frontend code. Every response is `no-store`. Errors are `{ error: { code, message } }`.

| Method/path | Contract |
| --- | --- |
| POST `/api/sessions` | `{description, scenario?, conversation?}` plus `Idempotency-Key` (16–80 alphanumeric/hyphen characters); 201 session + HttpOnly cookie (`Max-Age` 4 h). `scenario` defaults to `recovered`: the two regression fixtures are the starting sample until the first turn personalises it. Exact retries return the original session; conflicting input returns 409. |
| GET `/api/session` | Current browser's canonical session. |
| GET `/api/sessions/:id` | Cookie-owned canonical `DemoSession`: description, dataset `version`, `dataset`, append-only `conversation`, `conversationVersion`, `conversationTruncated`, `story`, `state`, `lastActiveAt`, `expiresAt`, `lastClientTurnId`. |
| GET `/api/sessions/:id/traces` | `{version, activeScenario, total, filtered, traces}`. Supports `q`, `scenario` (must be a trace key in this session's dataset), `detection=yes/no`, `tag`, `minMs`, `maxMs`. Search is case-insensitive canonical JSON substring; latency is the root span duration in milliseconds. |
| GET `/api/sessions/:id/traces/:traceId` | `{version, trace}` including flat parent-linked spans, I/O, errors and timing. |
| GET `/api/sessions/:id/traces/:traceId/spans/:spanId` | `{version, span}`. |
| POST `/api/sessions/:id/turns` | Owning cookie. `TurnRequest {text (1–2000), clientTurnId, choiceId?, openTraceId?}` → `TurnResponse {turnId, outcome, version, conversationVersion, messages, clarification?, evidence?, steps, execution}`. The server records a durable `running` turn, runs the agent with tools bound to this session only, publishes the validated dataset, story and run state in one transaction, then settles the turn (buyer turn status and Tailor's turns). A turn is not one transaction. Retrying the same `clientTurnId` returns the stored response without a new version (the last 16 runs per session are kept; a different body with a reused id is 409 `IDEMPOTENCY_MISMATCH`); a retry after a crash settles the interrupted turn instead of re-running it; a second concurrent turn gets 409 `TURN_IN_FLIGHT`. `openTraceId` (the trace open on screen) must belong to this session or the answer is 422 `TRACE_NOT_FOUND`; "Explain this trace" then explains that trace. If the agent fails, the reply says nothing changed only when the authoritative version is unchanged (`provider_unavailable`); otherwise it is `readback_uncertain`. `evidence` comes from an independent post-commit readback through the list/detail projections. |
| POST `/api/sessions/:id/end` | Owning cookie. Idempotent End demo: 200 `{ended: true}`, clears the cookie, deletes conversation and dataset now. |
| POST `/api/sessions/:id/scenario` | Owning cookie. NIT-265 regression path: `{expectedVersion, scenario: recovered/exhausted}`; 200 session with that canonical fixture. Stale version 409 keeps the previous data. |
| GET `/api/execution` | No session needed. `{execution: {mode, provider, model, effort}}`: the server-owned provider label the UI shows on every page. |
| GET `/api/dev/sessions` | Developer key header `x-tailor-dev-key`; lifecycle metadata of live local fictional sessions (ids, state, versions, counts; no content). |
| GET `/api/dev/telemetry` | Developer key. Telemetry delivery diagnostics: `deliveryState`, `exportFailures`, `redactedValues`, and `recentTurns` (`turnId` → `correlationId` → `traceId`). |
| GET `/api/dev/spend` | Developer key. Live spend summary (`spentUsd`, `reservedUsd`, `pendingCalls`, `unreconciledCalls`, `unreconciledUsd`, `degraded`, `capUsd`, `remainingUsd`); `{available:false}` for the mock. Estimates only; Anthropic billing is authoritative. |
| POST `/api/dev/sessions/:id/proposal` | Developer key AND owning cookie. `{expectedVersion, dataset}`; 200 accepted session. The dataset passes the same structural/coherence validator as agent proposals (`src/clients/neatlogs/validator.ts`); every trace/span ID must be derived from this session. |

Agent proposals (`ScenarioProposal`) are validated by code: schema, limits, single root, parents, cycles, timing containment, `ERROR` ⇔ error text, detections only on `ERROR`, `outcomeKind` vs. error spans, root output = trace output, no executable content, fictional hosts only. Code derives IDs (`${sessionId}-${traceKey}[-${spanKey}]`), `ingestedAt`, synthetic tags and `SYNTHETIC` prefixes. Transactions publish a complete validated document or nothing. Invalid data 422, stale version 409, unknown/cross-session ID or legacy cookie 404, expired 410 `SESSION_EXPIRED`, ended 410 `SESSION_ENDED`, missing developer key 403, unsupported method 405 (including the removed transcript-replacement route), unsupported filter 400, malformed JSON 400, content type 415 and >32KB body 413. Disconnects retain the last accepted version. Supported browser URLs are `/demo/:id/traces`, `/demo/:id/traces/:traceId` and detail `?span=:spanId`.

`npm run fixture -- validate --in-process` runs the developer harness against a disposable in-process server (temporary SQLite, random developer key, telemetry disabled, no agent or model). Runtime telemetry (`src/infrastructure/telemetry.ts`) defaults to no network: `disabled` is a no-op, `captured` keeps spans in memory (bounded) for tests, and `neatlogs` exports only when the composition root passes an explicit API key. Each turn is a `tailor.turn` trace with child spans per core step; a SIGKILL loses the current batch. Exported attributes are allowlisted (`tailor.*` token-like values plus SDK structural keys); correlation IDs are an HMAC of the session ID, and buyer text, cookies, descriptions and payloads are never attached.

See [reference and deviation notes](docs/nit-265-reference.md) for current-product observations and review boundaries.

## Local history

`setup/local` records the tracing setup at `c7b80e7ea3f5a9f08d306303d11ce08b379ffe98`. The next commit on that branch carries an Entire checkpoint trailer that does not resolve. This recovery branch starts from the setup commit, so that trailer is not part of this history.
