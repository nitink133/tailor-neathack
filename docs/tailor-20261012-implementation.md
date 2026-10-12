# Tailor implementation — 2026-10-12

This is the current implementation handoff for the separate `codex/tailor-20261012-integration` branch. It starts at independently verified main `17963acb6f7302384d278835697fefbd3ae6878c`. The primary checkout remains on `work/nit-269-build-personalised-tailor-agent-proof`; neither main nor the primary checkout was changed. No code was pushed, deployed or merged into main. All six newly created worktrees and the earlier worktrees are preserved.

## Product behavior

Tailor is a reusable buyer-led software demo agent. The shipped adapter is Neatlogs; buyer workflows can cover coding, research and industry examples within verified product capabilities. The core still enforces adapter-declared tools, validation, transactional compare-and-set publication, fresh readback, grounded explanations, spend reservation, idempotency and session isolation. A second test-only CRM adapter exercises the same core. The SQLite dataset projections and Neatlogs HTTP routes remain product-specific infrastructure; this run did not attempt a generic storage framework.

Entry and persistent chat visibly say **Powered by Tailor**. Three editable starter questions fill the composer without submitting. Execution labels distinguish the offline mock provider, synthetic trace data and live execution. Relevant missing context gets three choices plus free text. Small requested edits apply directly. A material switch offers **adapt current demo**, **start separate demo** within the same anonymous browser session, or **keep current**. Saved scenarios are retained. Explicit buyer switch intent is checked against normalized saved workflow identity independently of model mode or inherited story metadata.

Anonymous browser ownership is bootstrapped before creation. A signed HttpOnly browser cookie owns multiple demos; selection metadata has its own version. Creation and turn replay are idempotent, foreign owners cannot replay into another session, and active selection/evaluation writes recheck in-flight gates after reading request bodies. Switch confirmations bind the saved candidate, source version, conversation version and browser selection version. Stale confirmations fail safely.

The Neatlogs capability map contains 25 dated, source-backed records and separates verified product behavior, clone coverage, explain-only behavior, unsupported actions and account-dependent hosted access. The local Evals page stores immutable synthetic scenario snapshots and buyer review forms through isolated session APIs. It shows evaluator provenance and labels fixture scores as **simulated**; no hosted evaluator runs are implied. Starter scenarios cover an unsupported documentation answer, an invoice with a missing due date and a polite but unresolved support response. Tailor's runtime quality evaluations are a separate executable suite.

## Runtime safeguards and accounting

Cheap ownership, expiry, input, in-flight and cap checks happen before planning. A blocking classifier then receives the latest untrusted buyer turn, code-owned product remit, a compact capability summary and minimal pending-choice state. Outcomes are typed: product question, demo action, clarification, off-topic redirect or instruction-override denial. It is advisory classification, not authorization. Tools, schema validation, tenant/session checks and publication permissions remain deterministic boundaries.

The mock classifier is an explicitly labeled offline heuristic. Anthropic's structured classifier uses the existing transport and configured model, or optional `TAILOR_GUARD_MODEL` with configured rates. It uses low effort, a 1,024-token output ceiling, a 10-second timeout and no retry. Invalid or unavailable classification clarifies safely without planner dispatch or scenario mutation. Live classifier accuracy has not been measured. Quoted attacks can be fictional demo data; an unrelated assistant task does not become product work merely by mentioning Neatlogs.

Model context is bounded and records source IDs, trimming and component sizes. Exact UTF-8 byte counts are distinguished from estimated tokens. Every paid guard, planning, repair, escalation and explanation attempt reserves before dispatch and settles from reported usage, including billed errors. Cache-read, cache-write and thinking accounting do not double-count provider input/output. An unexpected overrun persists a degraded ledger and refuses future calls, including after restart. Configured prices and framing allowances are estimates; Anthropic billing is authoritative. This remains a single-server-process budget and in-flight design.

Capability answers are composed from verified records. A model lead is retained only when it exactly matches a supported source sentence; shared words alone cannot establish meaning or polarity. Trace narration retains a bounded grammar of status, recorded errors, names, versions and measured timings checked against fresh readback. Unsupported causal or recovery claims fall back to code-composed evidence. This favors truthful answers over varied model phrasing.

Jev, semantic routing and prompt caching have benchmark seams only. They are disabled, have no new runtime dependency and were not called. Hostile input can steer classifiers, including Jev; none is claimed to prevent injection.

## Observability and hosted verification

Pinned `neatlogs@1.1.28` creates one root trace per turn and supplies native session identity on each root through `neatlogs.session.id`. Browser session, demo, logical turn, client turn, HTTP request and reservation have separate HMAC-derived references. Code, prompt, adapter, contract, policy, model and knowledge versions are attached. Metadata alone is not described as native grouping.

Instrumentation covers context loading/selection, knowledge retrieval, blocking classification, every provider attempt, validation, declared tool dispatch, save, readback, explanation and response. It records allowlisted outcomes, state versions, source IDs, trimming, component bytes/token estimates, actual reported input/output/cache usage, latency, cost and settlement. Raw buyer text, credentials, model/tool payloads and chain-of-thought are excluded by default. Missing provider usage is unavailable, not zero.

An expected-event manifest is written from dispatch decisions independently of received telemetry. Persisted expectations survive interrupted/crashed turns. Diagnostics expose missing, duplicate, unexpected, cancelled and failed receipts, dropped/redacted attributes and exporter failures. A local flush returning successfully is not proof of hosted receipt: receipt verification remains unverified until independent readback matches the manifest.

Hosted execution is implemented but **not run in this implementation session**. `scripts/verify-hosted.ts` uses synthetic data and the mock provider, verifies an existing approved Doctor trace's project before sending, then checks independent hosted readback for exact project, root count, native grouping, parentage, correlation, versions, manifest receipts and privacy. Offline tests exercise decoded SDK transport and failures against localhost listeners with fake keys.

Only Tailor runtime project `18c4b4b6-0b1e-4d41-9405-7960fc2d0aa8` is accepted; sandbox `a35a7334-258e-441c-b2e1-b8198a263f21` is refused. Runtime `TAILOR_TELEMETRY=neatlogs` additionally requires the exact `TAILOR_NEATLOGS_PROJECT_ID`, a 32-hex `TAILOR_NEATLOGS_PROBE_TRACE_ID` from a previously approved Doctor probe and the verified US origin. Startup performs a read-only identity check before exporter initialization. Ingestion credentials do not prove eval-run access.

## Run and approval boundaries

Offline verification never loads `.env.local` and removes inherited model/ingestion keys:

```sh
env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY npm run typecheck
env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY npm test
env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY npm run build
env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY npm run test:ui
env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY npm run eval:quality
env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY npm run doctor:local
```

The smallest remaining live approvals are independent:

1. An explicit numeric total USD cap for a bounded Claude classifier/planner smoke journey, including guard calls. Keep one fixed ledger path. No default switch to another model or paid benchmark is implied.
2. Approval to export the bounded synthetic mock verification journey into the runtime project above, with the US region and key/project readback confirmed. Use an existing approved Doctor trace if available; creating a new probe trace itself needs external-ingestion approval. This does not authorize buyer payload export or hosted eval execution.

No secret values were read, printed or configured in this run. Real hosted eval availability and credential scope remain unknown. A production deploy also needs its own authorization, multi-process coordination, operational privacy/retention choices and live accuracy evidence.

## Team and ownership

All lanes ran concurrently in isolated worktrees under `.claude/worktrees/tailor-20261012-<lane>` with matching `codex/tailor-20261012-<lane>` branches. Contracts were delivered first and integrated as normal commits. Root integrated owned patch commits; nobody switched the primary checkout.

| Owner | Actual model | Files/contracts |
| --- | --- | --- |
| A | `gpt-6.1-sol`, high | Shared adapter/session/demo/tool contracts; store, HTTP routes, session tools, material-switch enforcement and architecture/browser ownership tests |
| B | `gpt-6-luna`, high | Browser client, CSS, entry/chat wording, starter and switch UI, Evals UI, Playwright |
| C | `gpt-6.1-sol`, high | Capability map/source evidence, synthetic eval DTOs/service/fixtures, eval tests and assigned reservation assertions |
| D | `gpt-6.1-sol`, high | Telemetry, expected evidence manifest, hosted verifier, privacy/delivery/completeness tests |
| E | `gpt-6.1-sol`, high | Entry policy, adapter/provider/context/prompts, mock workflow routing, runtime quality harness and assigned test fixtures |
| Root | Inherited orchestration model | Core/lifecycle, transport/spend/accounting, project startup gate, grounded answer/explanation, root regression tests and handoff |
| Independent reviewer | `gpt-6.1-sol`, xhigh | Read-only adversarial review and isolated reproduction against integration commits |

## Entire continuity

The maintained project skill was read and used in the actual checkouts. Entire is `0.11.4`; the caller's desktop executable is Codex `0.162.0-alpha.17.2`, while PATH Codex is `0.153.4`. Caller environment identifies session `01a12dac-e314-74f3-ac2c-6ae6f025106a`, but `entire session current --json` finds no caller state and `entire session info` reports it missing. Installed hooks and a session ID do not prove fresh lifecycle capture.

Nitin explicitly waived blocking implementation on this gap: “Don't worry about the Entire much. We need to track the work there as part of the hackathon requirements but let's not block the work because of it.” No hook, trust, authentication or global configuration was changed. No historical imports, transcript uploads, fabricated trailers or amendments were made. New implementation commit checkpoint linkage is unverified. The 129 local checkpoint refs remain preserved; prior remote matching and imported history are historical evidence, not fresh capture. Remote sync/dashboard ingestion were not rechecked because there was no authorized push. Usage for this session is unavailable.

## Verification record

Final integration SHA, exact checks and final owned lane commits are recorded here after the last review fixes are integrated. Intermediate failures were retained as evidence and fixed before acceptance. Live Claude/Jev accuracy, paid caching benchmarks, hosted ingestion/readback and hosted eval execution are not part of the offline pass criteria.

Relevant official references: [native Neatlogs sessions](https://docs.neatlogs.com/sdk/sessions), [Neatlogs evals](https://docs.neatlogs.com/docs/features/evals), [account-dependent API availability](https://docs.neatlogs.com/api-reference/availability), [Jev hostile-input caveat](https://docs.typesafe.ai/model-jaggedness/jev-1.13). Capability records retain their individual source URLs and verification dates.
