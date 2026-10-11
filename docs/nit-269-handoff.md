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
| `TAILOR_PROVIDER` | `mock` | `mock` (offline) or `anthropic` (live; needs `ANTHROPIC_API_KEY` and `TAILOR_LIVE_CAP_USD`, see below). Anything else exits with code 2. |
| `TAILOR_MODEL` / `TAILOR_EFFORT` | `claude-sonnet-5-5` / `medium` | Live mode only. Effort must be one of low, medium, high, xhigh, max. |
| `TAILOR_LIVE_CAP_USD` | unset | Live mode only; required, numeric, your explicit approval. |
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

## Live provider (Anthropic, approval-gated)

The live baseline is implemented and offline-tested; it runs only when you enter the key and approve a cap. Nothing falls back to the mock in live mode.

| Setting | Value | Verified against |
| --- | --- | --- |
| Model | `claude-sonnet-5-5` (configurable via `TAILOR_MODEL`) | Anthropic model overview: Claude API id `claude-sonnet-5-5`, $2 / $10 per MTok |
| Thinking | adaptive (`thinking: {type: "adaptive"}`, the model default) | Thinking docs: `disabled` and `enabled/budget_tokens` return 400 on Sonnet 5.5 |
| Effort | `output_config.effort: "medium"` (configurable via `TAILOR_EFFORT`) | Effort docs: `medium` is the documented cost step-down from the `high` default |
| Output | structured JSON via `output_config.format` (`client.messages.parse`), no tools / `tool_choice` | Structured outputs docs |
| SDK | `@anthropic-ai/sdk` 0.133.0, exact pin | Official TypeScript SDK |

Per turn: one planning call (interpret, choose a supported action, propose a scenario or ask one three-choice clarification) and, after a successful save and read-back, one explanation call that receives only the read-back evidence. Knowledge retrieval, permissions, schema/timing/relationship validation, persistence, version checks and read-back stay in deterministic code; model output is validated structurally and grounded before use. Refusals (`stop_reason: refusal`), truncation (`max_tokens`), malformed output, 401/403/402, 429, 529, timeouts and network errors are mapped to a `ProviderErrorKind`, recorded in telemetry and surfaced to the buyer as a generic "nothing changed" reply.

**Where to enter the key (you, not the assistant):** open `.env.local` in the repo root (gitignored, `chmod 600`; create it from `.env.example` if missing) and set `ANTHROPIC_API_KEY=` to a server-side key from the Anthropic Console project `tailor-neathack`, plus `TAILOR_LIVE_CAP_USD=` to the numeric cap you approve. Do not paste the key in chat, a shell `export`, a commit or any log. `npm run env:check` reports only set/missing.

**Spend guard:** `TAILOR_LIVE_CAP_USD` is required in live mode (0 < cap ≤ 50). Before every call the guard checks a worst-case estimate (prompt chars/4 input tokens + the call's `max_tokens`) against the running total; after every call it records provider-reported usage (input, output, thinking, cache read/write) × list rates into `.local/spend-ledger.json`, which survives restarts. `GET /api/dev/spend` (header `x-tailor-dev-key`) shows the summary. All USD figures are local estimates from reported usage; final Anthropic billing is authoritative and may differ.

**Start:** `npm run dev:live` → `http://127.0.0.1:4321` (if 4321 is busy: `PORT=4323 npm run dev:live` → `http://127.0.0.1:4323`). The startup line prints provider, model, effort and cap (never the key). `npm run dev` stays mock-only. `TAILOR_PROVIDER_DEBUG=1` additionally logs the API's own error type/message to stderr for 4xx/5xx diagnosis (operator-only; no prompts or keys).

**Verified 2026-10-12** under an approved $5 cap: `npm run smoke:live` 8/8 PASS against `claude-sonnet-5-5` / medium; details, defects found by the first live calls and provider-reported usage are in `docs/nit-269-evidence.md` §9.3. Observed cost: ≈ $0.03 per committed turn, ≈ $0.02 per clarification/unsupported turn (estimates).

**Manual test checklist (invented buyer data only):**
1. Open `http://127.0.0.1:4321/entry`; the panel shows "Powered by Tailor · synthetic data" and no "Mock-backed" label.
2. Send: *I'm building a travel-booking agent. Show me a booking API timeout followed by a successful retry.* Expect an applied reply citing a failed `…attempt_1`-style span, "Evidence · v2", and the trace in the list/detail/timeline views.
3. Send: *Make the retry fail too.* Expect version 3, two traces retained, the new active trace with two ERROR spans, and an explanation that names only spans visible in the trace detail. Live turns take 12–20 s (planning ≈ 10–15 s, explanation ≈ 3 s).
4. Reload the page: conversation and version unchanged.
5. Send: *Show me something failing.* Expect one question with exactly three choices and a free-text hint; pick one.
6. Send: *Set up Slack alerts for this project.* Expect an "outside this demo" reply (or a refusal to change real settings) with the version unchanged.
7. Check `GET /api/dev/spend` (or `npm run smoke:live` for the scripted version of steps 2–6) and compare the estimated USD with the Anthropic Console later.

## Approval gates (explicit, in order of likely need)

1. Live provider run: you enter `ANTHROPIC_API_KEY` in `.env.local` and confirm a numeric `TAILOR_LIVE_CAP_USD`. No paid call happens before both exist.
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
