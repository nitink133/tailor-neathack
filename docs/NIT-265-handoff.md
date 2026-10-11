# NIT-265 handoff — buyer conversation

11 October 2026. Worktree `/Users/nitinkhanna/.codex/worktrees/8dc3/tailor-neathack`, branch `codex/nit-265-replica-app`. No new worktree. NIT-269 was not started.

## What works

The landing CTA and `/entry` open one conversation instead of the description form and scenario radios. There is no company-name field and no questionnaire. The opening line asks which fictional failure to explore, with two example prompts. An unclear reply gets one follow-up. Choosing a fixture creates the existing cookie session and moves that same thread into a side panel beside the trace list and detail.

The composer stays available. It can switch the active fixture, explain the open synthetic trace, or say the request did not change anything. A switch shows Pending, then Applied only after `POST /api/sessions/:id/scenario` returns and the trace list reports the same version and active fixture. A failed save shows Failed and leaves the last accepted fixture in place. Repeating the already-saved fixture does not publish another version.

The transcript is stored on that session and comes back after navigation, Back, Forward, direct links, and reload. Collapse and reopen keep it. Below 900px the panel is a bottom sheet; at 390px the document does not scroll sideways. List and detail both read the same session document, so the active fixture and the thread match.

## What is simulated

There is no model and no Neatlogs agent. Replies come from `src/adapter.ts`, labelled **Deterministic prototype adapter** in the UI and in every adapter message. It only understands the two canonical fixtures: retry recovers, or both attempts fail. “Explain this trace” restates the saved active fixture. It does not read Neatlogs, and it does not invent Ask neat AI, Deep, or Neatlogs Fast.

No supplied chat screenshot was in the workspace, the audit folder, or the conversation files. The empty state follows the official chats page opened read-only on 11 October: landscape background, centered greeting, 28px composer, suggestion links underneath. Official chips for workflows, Deep, and Neatlogs Fast were not copied. The greeting is “hello” with no account name. The existing official chat history was not opened.

## Where state lives

- Session document in `.local/tailor.sqlite` (gitignored): `conversation` on the cookie-owned session, beside the canonical dataset. Isolation is the existing HttpOnly cookie.
- Before a session exists, the draft is `sessionStorage` key `tailor-draft-chat`.
- Collapse is `sessionStorage` key `tailor-chat-collapsed:<session id>`.
- Fixture changes use `POST /api/sessions/:id/scenario` with `expectedVersion`. Stale versions return 409 and keep the previous dataset. Transcript writes use `POST /api/sessions/:id/conversation` and do not bump the fixture version.

## Tests

`npm run typecheck`, `npm test` (5/5), and `npm run test:ui` (5/5) passed after the conversation work. Browser checks on `http://127.0.0.1:4321` covered entry, the follow-up, the move into the panel, Back/Forward, direct link, reload, collapse/reopen, a repeated submission, and a blocked scenario save. Histogram bar, pager, selected detection chip, graph-open failure dots, and in-app Back still behaved as in the fidelity pass.

Screenshots, new names only:

- `docs/nit-265-ui-audit/chat-entry-before.png`
- `docs/nit-265-ui-audit/chat-entry-after.png`
- `docs/nit-265-ui-audit/chat-panel-after.png`
- `docs/nit-265-ui-audit/chat-panel-collapsed-after.png`
- `docs/nit-265-ui-audit/chat-failure-after.png`
- `docs/nit-265-ui-audit/chat-narrow-after.png`

## Unresolved audit items that affect this interface

- Ask neat AI on the trace header is still the unavailable toast. This thread is not that product. The earlier toast screenshot was byte-identical to another shot and showed no toast.
- Official chats can list older threads, pick workflows, a date range, Deep, and Neatlogs Fast. Those controls were visible and were not reproduced, because this demo has no model and no workflow catalogue.
- The official greeting uses the signed-in name. The replica does not.
- The conversation can only switch the two order fixtures. It cannot create the sandbox’s 10-trace catalogue, and saved text still does not personalize traces.
- Official editors for latency, metadata, and advanced filters were never opened. The chat does not drive them.
- Dark theme was not rechecked for the new panel.

## Remaining agent work

Replace `adapt()` with a real agent behind the same session, scenario, and conversation endpoints. Keep Pending until the demo API and the trace list agree. Remove the prototype label only when a real agent is actually connected. Do not point this adapter at the official Neatlogs project.

## Entire

Live capture for this Cursor session was unverified: `entire session current` resolved `caller-ambiguous`, idle, on the primary checkout’s `main`, not this worktree. Entire CLI 0.11.4. Hooks were not edited. The feature branch was committed locally and not pushed: the local push queue still contains checkpoint `01M4N6EYWDZSBDYK5N9G2C7J10`, and that ref is absent on origin. A normal pre-push drains that queue.
