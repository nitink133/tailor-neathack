# NIT-269 handoff — personalised Tailor agent proof

Branch `work/nit-269-build-personalised-tailor-agent-proof`, built on `main` at `bbb2600`. Nothing has been merged into `main` or deployed; both remain approval gates. This document states what works, what is mock-backed, what has not been verified, and what needs explicit approval. Test evidence with exact counts lives in [`nit-269-evidence.md`](nit-269-evidence.md); the seam is documented in [`nit-269-contract.md`](nit-269-contract.md); knowledge provenance in [`nit-269-knowledge-sources.md`](nit-269-knowledge-sources.md).

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
| `TAILOR_PROVIDER` | `mock` | Anything else exits with code 2. A live provider is an approval gate (see below). |
| `TAILOR_TELEMETRY` | `captured` | `disabled` (no-op), `captured` (in-memory, bounded), `neatlogs` (exports via the pinned SDK; exits 2 unless `NEATLOGS_API_KEY` is set in the shell). |
| `TAILOR_DEV_KEY` | unset | Enables `/api/dev/*` inspection routes. |
| `NEATLOGS_ENDPOINT` | SDK default | Only read in `neatlogs` mode. |

Gates: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:ui` (Playwright starts its own server on port 4322 with a throwaway database).

## What works (verified locally, mock provider)

- A buyer describes the agent they are building in the Neatlogs-styled entry page; one server-side agent interprets the request, proposes a `ScenarioProposal`, deterministic code validates it, saves it in one SQLite transaction, reads it back independently, and the reply cites only spans that exist in the read-back trace. The demo then shows the personalised trace in the list, detail, graph and timeline views.
- Follow-up edits ("Make the retry fail too.") keep the earlier trace, add the new one, and switch the active scenario; the reply explains what changed using the read-back evidence.
- Ambiguous requests get one clarification question with exactly three choices plus free text; choosing one resolves the turn. No company-name questionnaire.
- Explanations of the open trace ("Explain this trace") come from the saved spans, not from the model's memory of what it proposed.
- Questions about Neatlogs are answered from the versioned records in `knowledge/neatlogs/` (20 records, version `2026-10-11.1`). Official product claims are separated from what this clone can demonstrate. Pricing and plan availability are reported as unknown because they were not verified; hackathon access is not treated as proof of ordinary plan availability. Requests for features outside the records return `unsupported` with the dataset unchanged.
- Hostile input (prompt injection, requests to run code, to read another session, or to change the real Neatlogs project) is refused with the dataset version unchanged. Buyer text is HTML-escaped in the client.
- Sessions: HttpOnly, SameSite cookie bound to one session; 60 minutes idle or 4 hours total, whichever comes first, enforced on the server clock; expiry deletes the content and answers 410; **End demo** deletes immediately, clears the cookie, and leaves a content-free tombstone for 10 minutes; a sweeper runs every 5 minutes. Cross-session access answers 404 so existence is not leaked. No returning-buyer recognition.
- Reload restores the conversation from the server. Retrying the same `clientTurnId` returns the original response without a new version; a second concurrent turn on the same session gets 409 `TURN_IN_FLIGHT`. Conversations are capped at 120 turns and marked truncated rather than silently dropped.
- Save failure reports `save_failed` and says nothing changed only when the authoritative version really is unchanged; readback failure reports `readback_uncertain` and never claims success. Both paths are covered by injected faults.
- Runtime telemetry wraps the pinned Neatlogs SDK (`neatlogs@1.1.28`, `init`/`trace`/`span`/`flush`/`shutdown`, no invented endpoints or attributes). Each turn is a `WORKFLOW` trace with child spans for load_context, retrieve_knowledge, model, validate, save, readback and explain, carrying real latency, an HMAC-derived correlation ID (never the session ID), and allowlisted `tailor.*` attributes. Raw buyer text, cookies, descriptions and model/tool payloads are never attached. Exporter failures are counted in diagnostics and never fail a turn. Token usage is recorded only when a provider reports it; nothing is estimated.

## What is mock-backed

- `TAILOR_PROVIDER=mock` is the only provider. The mock (`src/agent/mock-provider.ts`) is heuristic: it recognises a bounded set of domains and failure shapes, so "unfamiliar wording" works to the extent the heuristics cover it. The UI labels this honestly ("Mock-backed prototype — no live model yet"); nothing pretends to be a live model.
- Because the provider is mock, model-quality claims (interpretation of arbitrary wording, proposal richness, explanation prose) are **not** verified. Everything deterministic around the model — validation, permissions, schemas, relationships, timing, session ownership, version checks, save/readback, lifecycle, telemetry shape — is verified and is model-free.
- The eval set (`docs/nit-269-eval-set.json`) measures the mock, not a model.

## Not verified / not run

- **External Neatlogs ingestion.** `TAILOR_TELEMETRY=neatlogs` is implemented against the official SDK contract and tested only with the local captured exporter. No trace from this branch has been sent to or looked up in a Neatlogs project. Running it needs the key in the shell environment (not `.env.local`), confirmation of the Tailor Neatlogs project and region, and your approval. The synthetic demo traces the buyer sees live only in SQLite and are never exported; Tailor's own runtime telemetry is what `neatlogs` mode would export.
- **Live model behaviour.** No live model call has been made and no charge incurred. `createProvider({ kind: 'live' })` throws until a provider/model is approved and configured.
- **Deployment.** Not attempted; no credentials created or configured.

## Approval gates (explicit, in order of likely need)

1. Live provider: provider and model ID, data-flow statement (buyer text leaves the machine), API eligibility, spend cap. Then wire it in `src/agent/provider.ts` behind `TAILOR_PROVIDER`.
2. External telemetry: Tailor Neatlogs project and region confirmed; key present in the shell; run `TAILOR_TELEMETRY=neatlogs npm run dev`, send a turn, and look the trace up by its correlation ID in that project before claiming ingestion works.
3. Merge into `main` and any deployment.

## Known limits

- The in-flight lock is per process; running more than one server process against the same SQLite file is not supported.
- Knowledge retrieval is keyword-bounded (`KnowledgeIndex.select`), deliberately without a vector store; records are small enough to fit the model context in full.
- Entire capture: commits on this branch carry hook-added `Entire-Checkpoint` trailers where the hook assigned one; see the Linear report for which checkpoint refs materialised. Missing refs are a capture gap to report, not something to repair by rewriting history.

## File map

| Area | Files |
| --- | --- |
| Contract | `src/agent-contract.ts`, `src/contracts.ts`, `src/examples/travel-booking.ts`, `docs/nit-269-contract.md` |
| Backend | `src/store.ts`, `src/server.ts`, `src/validator.ts`, `src/session-tools.ts`, `src/telemetry.ts`, `src/fixtures.ts` |
| Agent and UI | `src/agent/*`, `src/client.ts`, `public/style.css`, `src/main.ts` |
| Knowledge | `knowledge/README.md`, `knowledge/neatlogs/*.json`, `src/knowledge.ts` |
| Tests | `test/*.test.ts` (node:test), `ui/*.spec.ts` (Playwright) |
