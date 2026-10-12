# Contextual guidance integration — local review

Nitin approved the design direction and this integration run. The real buyer journey now uses answer-attached suggestions instead of the disconnected workspace guide strip. Landing-page/Paper work and other worktrees were not changed.

Review the real app at `http://127.0.0.1:4327/entry` in **mock provider / captured telemetry** mode. The earlier scripted design remains at `http://127.0.0.1:4326/assets/guided-preview.html`. Port 4325 was preserved.

## Behavior and contract

The existing planning response optionally chooses zero to three relevant destinations. No extra generation call is added. Code owns labels, purposes, destinations, binding validation, and navigation. Provider selections contain only a known target name and an optional saved trace ID; selectors, URLs, arbitrary actions and foreign trace IDs cannot enter the navigation contract.

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

Live model relevance, the revised planning schema's live grammar compilation, billing, and hosted telemetry receipt remain untested. No paid Claude/Jev calls, hosted exports, credentials/settings changes, push, main merge or deployment occurred. The implementation is ready for user review.

Restart locally from this worktree without loading secrets:

```sh
npm run build
PORT=4327 TAILOR_PROVIDER=mock TAILOR_TELEMETRY=captured TAILOR_DATA_PATH=.local/contextual-guidance.sqlite node src/main.ts
```
