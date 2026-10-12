# Buyer evals and routing adapter handoff

The feature adds docs-grounded eval advice, executed deterministic sample checks, saved synthetic alert routing previews and adapter-owned guidance. Worktree: `/private/tmp/tailor-evals-routing`; branch: `codex/neatlogs-evals-routing`; base: verified remote main `db855671fc4f3fe8e5bddfb7616f64fcc67714a9` on `Nitins-MacBook-Pro-2.local`. No main merge, deployment, paid call or real outbound action occurred. Port 4328, its database, ledger and credentials were untouched.

## Verified meaning and limits

See [primary research](neatlogs-evals-routing-research.md) for official documentation and authenticated screen evidence. Evals assign human/AI reviewers per structured question over captured trace/span datasets. Good eval guidance starts with the buyer's success standard, representative success/failure/ambiguous cases, observable checks and human calibration. Published plan descriptions do not establish a buyer's runtime entitlement.

Routing critical signals to people means Neatlogs alert destinations with action context, distinct from assigning evaluators and personal notification preferences. The native Alerts wizard is Type → Condition → Details → Response → Confirm. In-app is always on, email depends on preferences, Slack needs a connected integration and webhooks need configuration. The exact named action “Update me” was not verified. Tailor asks whether the buyer means monitored alerts, personal preferences or evaluation updates; it creates no future watch.

## Local buyer journeys

Ask about evals for any agent, then use the **Explore evals for this agent** guidance to open the saved demo's Evals form. Select traces, edit the questions and assign buyer or simulated reviewers. Optional checks execute over the immutable saved snapshot: no execution errors, bounded elapsed duration, and simple required output fields. Results show exact observations and evidence. Human answers and illustrative simulated verdicts retain separate source labels. A check passing does not prove truth, usefulness or production quality. Retrieval grounding and support resolution need explicit quality judgment even when execution passes; extraction can demonstrate a missing-field failure.

Ask to preview alert routing, then use **Preview alert routing** guidance. The five-step local wizard selects a per-event ERROR signal or a saved failure-outcome count, details and an allowlisted fictional role/destination. The saved detail displays matched trace/span evidence and hypothetical action context. It sends nothing. Thresholds count only `failure` outcomes; recovered and `escalation` outcomes do not count. Cooldown is recorded configuration; no timer, production window or scheduling runs. Metric/compound/ingestion-health rules and webhooks remain explanatory only.

The APIs enforce cookie ownership, active-session lifecycle, input allowlists and bounds, dataset versions, replay fingerprints and immutable snapshots. Editing the dataset marks old artifacts stale. Foreign trace/preview/evaluation IDs cannot reach another demo. Guidance is read-only and bound to the current session/version/trace. The agent's knowledge answers and guidance do not claim to run the UI's checks or dispatch a hosted evaluator.

## Validation

- `npm run typecheck` and `npm run build` pass.
- `npm test`: 418 passed, 0 failed; includes multiple buyer industries, injection/unsupported requests, deterministic checks, independent persisted reads, restart, idempotency, stale state and session isolation.
- `playwright test ui/evals-routing.spec.ts`: 4 passed against mock/captured server on port 4322 with worktree-local throwaway SQLite. Covers creation/review/results, invalid and failing checks, refresh/back/direct links/second tab, foreign browser isolation, routing and exact contextual targets. Screenshots visually checked at desktop and mobile; mobile headings wrap and tables scroll locally.
- Full feature browser run: 55 passed, 18 failed. Untouched verified-main archive on isolated port 4336: 52 passed, 17 failed. All 17 baseline failures matched the feature run. The sole additional feature failure was an established alert capability title expectation; restoring that title fixed it (`ui/agent.spec.ts:342`, 1 passed). A fresh full-suite pass is not claimed. Remaining baseline failures concern trace-list assertions after automatic guidance, pending/active demo behavior and legacy chat/tooltip styling; the integration owner should reconcile those with their current fixes.
- Live provider tests, real evaluator runs, probe/ingestion and outbound routing were not run.

Screenshots: [executed review](neatlogs-evals-routing-evidence/evals-executed-review-desktop.png), [mobile review](neatlogs-evals-routing-evidence/evals-executed-review-mobile.png), [missing field](neatlogs-evals-routing-evidence/evals-missing-field-desktop.png), [routing detail](neatlogs-evals-routing-evidence/routing-simulated-owner-desktop.png), [routing guidance](neatlogs-evals-routing-evidence/routing-guidance-desktop.png).

## Review and integration

Use a separate mock runtime without loading `.env.local`:

```sh
cd /tmp/tailor-evals-routing
PORT=4337 TAILOR_PROVIDER=mock TAILOR_TELEMETRY=captured TAILOR_DATA_PATH=/tmp/tailor-evals-routing-review.sqlite npm run dev
```

Open `http://127.0.0.1:4337`. The current worktree uses ignored package links to the existing installation; `npm ci` can replace them when needed. Keep the existing live demo on 4328 running independently. Try a documentation retrieval agent with an unsupported claim, a missing-field extraction workflow, a support response that fails to resolve the request, or an inventory timeout; open Evals or preview routing from contextual guidance.

The designated integration owner is thread `01a12f26-8424-749c-adff-b171d9f5d048`. Its active work intersects this branch at `public/style.css`, `src/clients/neatlogs/client.ts`, `answer.ts` and `src/infrastructure/server.ts`. This feature's server change only wires adapter-local routing routes/repository/error handling and the Alerts page fallback. The answer change keeps published plan notes as whole sentences. Reconcile those hunks after the current response/trace work lands; do not merge this branch independently. No generic Tailor core, telemetry, export or store file changed.

## Entire evidence boundary

The project Entire skill was read and followed from this worktree. Existing tracked hooks/settings were preserved. Entire 0.11.4 and PATH Codex 0.153.4 were observed; the actual desktop executable version was not independently established. Caller session `01a12fa6-df57-7177-9eb1-fb739cc42076` was identified but Entire reported no session state, so live capture, fresh lifecycle evidence and usage are unavailable. Shared-live-state status/doctor, imports, trust changes, transcript uploads and fabricated trailers were not used. Exact commit/checkpoint publication observations are reported separately at handoff; code publication alone does not establish capture or dashboard ingestion.
