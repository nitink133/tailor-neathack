# Contextual guidance integration — local review

Nitin approved the design direction and this integration run. The real buyer journey now uses answer-attached suggestions instead of the disconnected workspace guide strip. Landing-page/Paper work and other worktrees were not changed.

Current review: `http://127.0.0.1:4328/entry`, live Anthropic Sonnet 5.5, adaptive thinking, medium effort. Nitin subsequently authorized a $5 total cap and redacted synthetic exports to Tailor runtime project `18c4b4b6-0b1e-4d41-9405-7960fc2d0aa8`. The runtime ceiling is $4.75, on the existing durable ledger. Older Tailor ports 4321/4323/4325/4326/4327 were gracefully closed after live startup, as subsequently requested. No push, main merge or deployment.

## Behavior and contract

The existing planning response optionally chooses zero to three relevant destinations. No extra generation call is added. Code owns labels, purposes, destinations, binding validation, and navigation. The live structured wire uses known target-name strings; internal fixture compatibility permits an optional saved trace ID; selectors, URLs, arbitrary actions and foreign trace IDs cannot enter the navigation contract.

Targets are request steps/timing, the longest saved child step, a saved LLM step when one exists, and request output. There is no comparison action. Suggestions bind to the demo ID, dataset version, active scenario, authorized open/active trace, and resolved span. Code checks canonical IDs and exact target identity again before use. Clarifications, refusals, unsupported responses and uncited fallback answers have no actionable guidance.

Guidance persists with the answer and reappears after reload, with no automatic replay of a highlight. Clicking fetches/renders the current view, reveals the required ancestor path and observes a real connected visible target before reporting it shown. One ring and its short purpose remain beside chat. Repeated clicks are guarded against stale asynchronous navigation. Dismissal and Escape return focus to the selected suggestion. Ordinary navigation remains available; changed versions/scenarios disable old suggestions. Missing targets and rerenders remove the shown claim and present an inline recovery explanation. Narrow screens use separately scrollable product/chat regions with the selected card and explanation visible above a compact composer.

## Redacted observability

Selection count and resolution failures are recorded on the existing turn telemetry. `/api/sessions/:id/guidance-events` accepts only bounded message/suggestion IDs and closed outcome/reason enums, authorizes the session, checks the stored suggestion, and rejects stale `shown` reports. It cannot mutate the dataset. Interaction spans use hashed demo/message/suggestion/target references and code-owned target/outcome/reason values; no buyer text, selectors, URLs or raw product IDs are exported. A recorded local event is explicitly not hosted receipt or independent proof of browser pixels.

## Evidence

- Typecheck, browser build and diff whitespace check passed.
- 123 relevant unit/integration checks passed across provider/SDK wire, guidance pipeline, architecture, store, HTTP isolation/lifecycle, guide primitives and telemetry/privacy/completeness. This includes genuine structured Anthropic responses through an injected offline transport, 0–3 suggestions, malformed/unknown/foreign/stale targets and clarification/refusal exclusions. No paid API was used.
- 4 contextual browser checks passed: reload, repeated clicks, dismissal/focus, normal navigation, scenario changes, missing DOM target, theme rerender and explicit target collapse without a false shown claim.
- 6 annotation browser regressions passed: filters, dark styling, keyboard/touch field help, fallback dismissal and ancestor reveal. Old strip-specific assertions were updated for answer-attached suggestions.
- 5 earlier scripted-preview checks passed; it remains separate and usable.
- Actual Chrome support journey verified the saved slow lookup target and visible chat. Desktop/narrow saved pixels were inspected: `contextual-guidance/desktop.png`, `contextual-guidance/narrow.png`.

The reported unchanged full-suite baseline was reused; no full clone audit or repeated full suite was run. Targeted reruns followed fixes for real target/copy alignment, narrow visibility and rerender truthfulness.

## Provenance and limits

Worktree: `.claude/worktrees/tailor-guided-design-preview`; branch: `codex/tailor-guided-design-preview`. Integration started at design commit `3b7c57d7d81bafb964a19084fcb948d6605ea09c`, based on annotation closeout `3d91d542a720854dd0086aeed5342aa1b4fca09a` (previously verified against its remote branch). Three integration agents used inherited GPT-6: backend/contract, UI and independent focused tests.

Entire 0.11.4 identified caller `01a12f26-8424-749c-adff-b171d9f5d048` but had no session state. Live capture/checkpoint linkage and usage remain unverified/unavailable; no hooks, settings, trust or history were changed. This is explicitly nonblocking.

The original mock-only boundary was superseded by Nitin’s live/hosted approval. Two real support-workflow turns persisted and independently read back versions 2 and 3, with three then two valid suggestions. Initial grammar/provider failure and strict workflow-noun clarification were resolved by a simpler enum wire and explicit noun preservation, without bypassing validation. Prompt version is now .4. Billing remains authoritative; no Jev calls or external judge were used.

Restart locally from this worktree without loading secrets:

```sh
npm run build
PORT=4327 TAILOR_PROVIDER=mock TAILOR_TELEMETRY=captured TAILOR_DATA_PATH=.local/contextual-guidance.sqlite node src/main.ts
```


## Reported issue closure, 12 October

- **Side panel**: restored Tailor/star identity, compact purpose cards and unboxed answer prose. Real input stays pinned. Verified normal, narrow (320/390), dark, dismissal and focus. See `contextual-guidance/panel-corrected-*.png`.
- **Clone chrome**: fixed touching dropdown carets and moved expanded sidebar collapse control beside logo. Browser geometry checks and desktop/narrow pixels verified.
- **Entry**: generic seed rows concealed during pending, clarification and failure. Actual turn progress remains visible with chat. A committed, independently refreshed matching version automatically reveals the first validated guide once; reload does not autoplay. Follow-up replaces old binding, ordinary navigation/dismissal preserved. Browser tests passed.
- **Valid eval question**: exact request “What kind of eval I can implement in my agent and how neatlogs can help?” was answered successfully by live model turn `2e00fa99-db1d-4c5c-8e28-084e1e7c2539` in demo `5092feb2-2424-4fbc-ba8d-99da0520d15b`. Code then expanded four capability blocks and core clipped 2,000 characters. Composition now prioritizes relevant cited records, reserves source/availability space and preserves whole sentences. Exact regression yields 589 characters; no fresh paid retry was needed.
- **Hosted evidence**: exact failed-UX trace `008fcb7d4f4724a148c039d42742c2a4` is received in the approved project, status success, but old export exposes no input/output, zero tokens and mostly empty metadata. New mapping supplies SDK model/token fields and strict redacted metadata/events, with a verifier for actual API projection. Trusted synthetic payloads require an operator demo-ID allowlist plus per-turn flag; other sessions omit text. This does not retroactively repair old traces. Full prompts, hidden reasoning and raw tool payloads remain excluded. New hosted receipt must be separately verified.

Latest targeted pass: typecheck/build and 104 unit/integration checks passed; final 10 affected browser checks passed. The final telemetry alias/cost changes passed 19 focused checks. Prior full-suite baseline reused. All supplied screenshots were inspected: approved/old panel pair (`ce44...`, `0cbe...`), clone defects (`bf3d...`, `d2fa...`), entry seeds (`c3de...`), eval failure pair (`ec4b...`, `b7b4...`) and hosted step-only view (`f576...`).

The sole live server keeps the existing ledger. Last observed estimate before refresh: $1.260834 spent, $3.489166 remaining under $4.75, zero pending/unreconciled calls. A bounded read-only monitor logs structural local/hosted evidence in `.local/review-monitor.jsonl`; no model calls or external judge. It stops within two hours, by UTC day end, or on creation of `.local/review-monitor.stop`. The app scheduling tool rejected this delegated cloud thread as nonlocal; no scheduled automation was created. Absence of fresh traces does not prove successful testing.

Entire current caller still has no state; live capture, checkpoint linkage and usage remain unverified/unavailable. This is nonblocking. No fabricated trailers, history imports or hook changes.


Publication inventory: fresh remote main is `17963acb6f7302384d278835697fefbd3ae6878c`, an ancestor of the reviewed integration. `17e40c2`, `3d91d54` and `29e18e8` are all ancestors; main can advance without conflict. Original lane A–E patch sequences are accounted for in `tailor-20261012-implementation.md`; already cherry-picked/adapted work is not blindly merged again. Unrelated recovery/older replica branches are preserved. Outgoing changed source/path scan found no credential patterns, env files or local database/ledger files.

**External observability blocker:** two new model-free mapping receipts (`900c8c5f3ac56742846d85abd3e632f3`, `bdb57ee46bde9aa7c9a82fb9e0916ae9`) independently confirm exact native synthetic input/output in the approved project. Both SDK-documented `metadata` and `neatlogs.metadata` envelopes disappear from hosted `span_metadata`, which contains only `session.id`. Full received event/identity reconstruction therefore remains unverified. Native model/token/cost mapping is now independently verified by the fresh live regression below. No synthetic check invents model usage or claims Claude execution. This is not an all-items-closed claim; remaining work requires the hosted projection to expose safe metadata or a supported received-evidence API.


## Published live regression

Published implementation `374d402ab2fd7a8206de8edd0bd437c2dac1fd48` was fast-forward merged to main and pushed with its branch. Local/remote main and branch matched. Historical annotation checkpoint `01M4QHNXRMR5NNJEVGT26JM2AJ` local/remote ref SHA matched `d374f4115c618b22439e9ef6c6bafd9c6f0421a4`; this is historical sync, not capture of this caller. All 16 inventoried worktrees were clean and preserved at verification time.

A bounded real Claude retry of the exact eval question after publication returned **answered**, **589 characters**, complete ending and sources; session version remained 1. Turn `251caf3d-ac33-47d8-bb0a-b03b1866ba1f`, runtime trace `e17f089e40d76ac3183f318e7cbb6355`; local receipts 14/14. Hosted GET returned 200/success in the runtime project. Guard: LLM Sonnet 5.5, 1,626 input / 25 output, estimated cost $0.003502. Planning: LLM Sonnet 5.5, Anthropic, 9,021 input / 539 output, estimated cost $0.023432. The guard provider field remains absent in the hosted projection; no provider identity is inferred from that missing field. Total regression estimate $0.026934. Missing reasoning/cache detail is unavailable, not proof of zero.

Current durable total estimate **$1.287768**, remaining **$3.462232** under $4.75, pending/unreconciled zero. This new regression session was outside the explicit text-export allowlist, so its payloads were intentionally omitted. Native synthetic input/output was proven separately by the model-free checks. Full hosted custom metadata/event reconstruction remains blocked as described above; no all-open-items-closed claim.

Bounded read-only monitor PID at startup: 79186. Log `.local/review-monitor.jsonl`; stop marker `.local/review-monitor.stop`. It makes no model calls/ingestion and ends two hours after startup or by UTC day end. The live server remains on 4328, preserving the database and durable ledger. No deploy or Paper work.
