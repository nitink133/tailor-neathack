# NIT-269 contract snapshot `2026-10-11.1`

Owner: orchestrator (NIT-270). Frozen for the backend (NIT-273), agent/UI (NIT-272) and QA (NIT-271) lanes. Contract changes go through the orchestrator; lanes do not edit `src/contracts.ts`, `src/agent-contract.ts` or `src/examples/*` concurrently.

## Files

| File | Purpose |
| --- | --- |
| `src/contracts.ts` | Persisted data: `DemoSession`, `Dataset`, `Trace`, `Span`, `ChatTurn`, `Story`, `Clarification`, `Evidence`. Generalised from the two NIT-265 fixtures: `scenario` is any slug, traces carry `label` and `outcomeKind`. |
| `src/agent-contract.ts` | `LIMITS`, `ScenarioProposal`, `PublishResult`, `SessionTools`, `TurnRequest`/`TurnResponse`, `AgentService`, `ModelProvider`, `CapabilityRecord`/`KnowledgeIndex`, `TurnTelemetry`, `Clock`. |
| `src/examples/travel-booking.ts` | Travel-booking timeout → retry succeeds (v1, `mode: 'new'`), then "make the retry fail too" (v2, `mode: 'edit'`); refusal/unsupported/ambiguous request examples. |
| `test/contract.test.ts` | Model-free coherence checks over the examples and the regression fixtures. |

## Turn flow

```
POST /api/sessions/:id/turns  (owning cookie; body TurnRequest)
  server: authorise → lifecycle check (idle 60 min / lifetime 4 h / ended) → one-in-flight lock → idempotency by clientTurnId
  server: append buyer turn (conversationVersion+1)
  agent:  load_context → retrieve_knowledge (≤6 records) → model (≤3 calls, ≤2 repairs, ≤1 escalation)
  agent:  action = ask | propose | explain | answer | unsupported | refuse
  tools:  publishScenario = validate → BEGIN IMMEDIATE save → COMMIT → independent readback (list + detail)
  server: append tailor turns + story in one transaction → TurnResponse
```

Code, never the model, enforces: cookie ownership, session lifecycle, schema, counts/sizes, single root, parent linkage, timing containment, `ERROR ⇔ error`, detection only on `ERROR`, `outcomeKind` vs. error spans, root output = trace output, fictional hosts only (`*.example`, `*.test`, `*.invalid`, `localhost`), no executable content, `expectedVersion` precondition, atomic publication and readback before any success claim. Persisted IDs are derived by code: trace `${sessionId}-${traceKey}`, span `${sessionId}-${traceKey}-${spanKey}`; `ingestedAt` is the server clock.

## Outcome states (distinct, tested)

| `PublishResult.state` / `TurnOutcome` | Meaning | Buyer-facing rule |
| --- | --- | --- |
| `committed` | Saved and independently read back | May say "saved"; cite `evidence.traceIds/spanIds/version` from the readback |
| `rejected` | Validator refused after bounded repairs; nothing written (verified by re-read) | Say what was invalid; "last good version N is still live" |
| `save_failed` | Write failed, known unchanged | Same as rejected, with the reason |
| `readback_uncertain` | Transaction may have committed, readback failed | Say uncertain; never "unchanged" or "saved"; UI re-reads before next action |
| `conflict` | `expectedVersion` ≠ current | Nothing written; re-read and retry |
| `unsupported` | Outside clone capabilities | Explain-only or unknown; no fabricated feature |
| `refused` | Injection, arbitrary code, cross-session, real-product mutation | Short refusal, state unchanged |
| `expired` | Idle/lifetime/End demo | Access removed; conversation and demo data deleted |
| `clarification` | One material ambiguity | One question, exactly three relevant choices, free text allowed |
| `provider_unavailable` | Provider failed within budget | Nothing written |

## Example journey (travel booking)

1. Buyer: "I'm building a travel-booking agent. Show me a booking API timeout followed by a successful retry." → model returns `travelProposalV1` (`expectedVersion: 1`, `mode: 'new'`) → validator ok → save → readback returns version 2, trace `${sid}-booking-timeout-retry-ok`, 7 spans, 1 `ERROR` (`attempt-1`) → explanation cites those span IDs and the 2860 ms root.
2. Buyer: "Make the retry fail too." → `travelProposalV2` (`expectedVersion: 2`, `mode: 'edit'`) adds `booking-timeout-retry-fails` (2 `ERROR` spans, `attempt-2` is a detection, `outcomeKind: 'escalation'`) and makes it active; the v1 trace is carried over → version 3 → explanation names `attempt-1`, `attempt-2`, `escalate_to_travel_desk` and the `charged: false` output.
3. Failure examples: stale `expectedVersion` → `conflict`; a span whose parent is missing → `rejected` with `UNKNOWN_PARENT`; "delete the real Neatlogs project" → `refused`; "set up a Slack alert here" → `unsupported` (explain-only); "show me something failing" → `clarification`.

## Lifecycle

Server clock only (`Clock` is injectable for tests). Idle 60 minutes, lifetime 4 hours, explicit idempotent `POST /api/sessions/:id/end`. Reload within an active session restores the saved version. Expiry/end deletes the session row (conversation + dataset); a sweep every `LIMITS.sweepIntervalMs` removes sessions nobody revisits. Legacy seven-day cookies are treated as unknown sessions (404). No returning-buyer recognition.

## Conversation concurrency

Server appends turns; the client never replaces the transcript. `conversationVersion` increments per accepted append. One in-flight turn per session (`TURN_IN_FLIGHT` 409 for a second). Retrying the same `clientTurnId` returns the original response. History is bounded to 120 turns; older turns are trimmed server-side and `conversationTruncated` is set so the UI can say so.

## Telemetry

Real Tailor execution goes through `TurnTelemetry` (backend-owned exporter built on the pinned `neatlogs` SDK: `init`/`trace`/`span`, `disableExport`/caller-owned `tracerProvider` for the local captured exporter, `mask` for redaction). Synthetic demo traces never go there. Correlation IDs are opaque; raw buyer text, cookies and full payloads are not exported by default. Usage is recorded only when the provider reports it.

## Not in this snapshot

Provider/model IDs, money budgets, live telemetry destination approval, pricing facts (knowledge lane records them as known-with-source or unknown).
