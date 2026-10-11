# Tailor

Tailor is a candidate project for neatHack (October 2026), currently under validation.

NIT-265 adds a bounded local Neatlogs replica: landing, a buyer conversation, trace list, span details, tree and timeline. Every session contains two deterministic order lookup fixtures. Visitor text is saved; it does not generate personalization. The conversation is a labelled deterministic prototype adapter. No LLM or agent runs.

## Run the replica

Use Node >=26.7.0 and npm >=11.19.0 on the personal Mac.

```sh
npm ci
npx playwright install chromium # once, for browser tests
npm run dev
```

Open http://127.0.0.1:4321. The server binds loopback only. It deliberately does not load `.env.local` or use the Neatlogs key. Existing real SDK integration remains separate; do not mistake the replica fixtures for real Tailor execution telemetry.

For developer inspection and proposal validation, start the server with a local key, then use the same environment in another terminal:

```sh
export TAILOR_DEV_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run dev
# In a terminal with the same TAILOR_DEV_KEY:
npm run fixture -- validate
npm run fixture -- inspect
```

`validate` creates two fictional sessions, rejects a broken parent, verifies unchanged state, publishes a corrected supported fixture at v2, independently reads it back, rejects stale v1 and denies another session's read/write. `inspect` returns saved descriptions, scenario/version and canonical records; it requires the developer key. Never use real buyer input. `TAILOR_URL` selects another loopback port; `PORT` changes the server port; `TAILOR_DATA_PATH` changes the SQLite file.

Data lives in gitignored `.local/tailor.sqlite` with SQLite WAL/SHM sidecars. The directory is private (0700 when created); the persisted signing secret lets the browser's HttpOnly/SameSite cookie survive a server restart. A cookie grants one session only. A new session replaces that browser's cookie; older sessions remain available to authorized developer inspection. Full auth, sharing and retention policy are outside this local fictional proof. Nothing automatically expires from SQLite; manually reset after review, with the server stopped:

```sh
rm -f .local/tailor.sqlite .local/tailor.sqlite-wal .local/tailor.sqlite-shm
# Optional browser-test dataset reset, also with its server stopped:
rm -f .local/ui-test.sqlite .local/ui-test.sqlite-wal .local/ui-test.sqlite-shm
```

These commands destroy only the named local fictional datasets and invalidate their cookies; do not point the server at buyer data. No reset was applied to the primary checkout or another worktree.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:ui
npm run doctor:local
```

There is no lint script. Browser screenshots default to `test-results/evidence`; set `TAILOR_SCREENSHOT_DIR` to a review folder to preserve them. Tests use disposable fictional data, local request interruption/failure simulation and a test-only developer key. The HTTP tests close/reopen the database/server to verify restart persistence, full-document rollback, concurrent CAS conflicts and cross-session denial.

`doctor:probe`, `env:check` and `smoke:trace` retain their existing meanings in AGENTS.md. Authenticated probing and synthetic real trace ingestion were not run for NIT-265 because the real account is read-only for this task. `neatlogs` remains pinned to 1.1.28. `npm audit` reports 10 moderate and 4 high advisories in its existing SDK/OpenTelemetry/protobuf dependency chain; this slice does not upgrade that integration.

## API contract

Types live in `src/contracts.ts`; all UI projections originate in the session's single canonical dataset. Cookies and developer keys are never embedded in frontend code. Every response is `no-store`. Errors are `{ error: { code, message } }`.

| Method/path | Contract |
| --- | --- |
| POST `/api/sessions` | `{description, scenario}` plus `Idempotency-Key` (16–80 alphanumeric/hyphen characters); 201 session + HttpOnly cookie. Exact retries return the original session; conflicting input returns 409. |
| GET `/api/session` | Current browser's canonical session. |
| GET `/api/sessions/:id` | Cookie-owned canonical session including saved description, version and active fixture. |
| GET `/api/sessions/:id/traces` | `{version, activeScenario, total, filtered, traces}`. Supports `q`, `scenario`, `detection=yes/no`, `tag`, `minMs`, `maxMs`. Search is case-insensitive canonical JSON substring; latency uses milliseconds. |
| GET `/api/sessions/:id/traces/:traceId` | `{version, trace}` including flat parent-linked spans, I/O, errors and timing. |
| GET `/api/sessions/:id/traces/:traceId/spans/:spanId` | `{version, span}`. |
| GET `/api/dev/sessions` | Developer key header `x-tailor-dev-key`; inspect all saved local fictional sessions. |
| POST `/api/sessions/:id/scenario` | Owning cookie. `{expectedVersion, scenario}`; 200 session with the canonical fixture for that scenario. Stale version 409 keeps the previous fixture. |
| POST `/api/sessions/:id/conversation` | Owning cookie. `{conversation}` replaces that session’s transcript only. It does not change the fixture. |
| POST `/api/dev/sessions/:id/proposal` | Developer key AND owning cookie. `{expectedVersion, dataset}`; 200 accepted canonical session. Only exact supported fixtures with either active scenario validate. Immutable ownership/input/IDs; no arbitrary personalization. |

Transactions publish a complete validated document or nothing. Invalid fixture 422, stale version 409, unknown/cross-session ID 404, missing developer key 403, unsupported method 405, unsupported filter 400, malformed JSON 400, content type 415 and >32KB body 413. Disconnects retain the last accepted version. Supported browser URLs are `/demo/:id/traces`, `/demo/:id/traces/:traceId` and detail `?span=:spanId`.

See [reference and deviation notes](docs/nit-265-reference.md) for current-product observations and review boundaries.

## Local history

`setup/local` records the tracing setup at `c7b80e7ea3f5a9f08d306303d11ce08b379ffe98`. The next commit on that branch carries an Entire checkpoint trailer that does not resolve. This recovery branch starts from the setup commit, so that trailer is not part of this history.
