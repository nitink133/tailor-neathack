# NIT-265 UI fidelity audit

11 October 2026. Read-only. No implementation changes, and this report is not committed.

## Verdict

Sign-in worked. The Tailor Demo Sandbox traces list, an exhausted trace (scenario 06), and a recovered trace (scenario 03) were opened read-only and compared with the local replica.

The first pass found the histogram, pager, selected filter, and graph-open detection mismatches below. Those, and the other confirmed visual and functional findings in this report, were fixed on `codex/nit-265-replica-app` as uncommitted working-tree changes. The deliberate exclusions and the unverified items were left alone.

## Fix status

11 October 2026, after the read-only audit. No commit. Checked in the browser at `http://127.0.0.1:4321` on the existing local session, viewport 1630×1298. `npm run typecheck`, `npm test`, and `npm run test:ui` passed after the changes.

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Histogram day cell | Fixed | `docs/nit-265-ui-audit/list-histogram-pager-local-fix.png` |
| 2 | Synthetic notice over the pager | Fixed | same screenshot; notice sits above `1 – 2 of 2` |
| 3 | Applied filter chip | Fixed | `docs/nit-265-ui-audit/list-filter-selected-local-fix.png` |
| 4 | Graph-open failure dots | Fixed | `docs/nit-265-ui-audit/detail-graph-dots-local-fix.png`; closed gutter in `detail-graph-closed-local-fix.png` |
| 5 | Graph kind icons | Fixed | `detail-graph-dots-local-fix.png` |
| 6 | Empty-state icon and button | Fixed | `docs/nit-265-ui-audit/list-empty-local-fix.png` |
| 7 | Labeled sidebar | Fixed | `docs/nit-265-ui-audit/list-sidebar-local-fix.png` |
| 8 | Landing scrollbar | Fixed | `docs/nit-265-ui-audit/landing-local-fix.png`; document scroll height equals the viewport |
| 9 | Hackathon strip | Fixed | same landing screenshot; 32px, `#028dc2`, date chip |
| 10 | Wordmark | Fixed | same landing screenshot; Geist Mono, 20px from the left edge |
| 11 | Nav chrome | Fixed | same landing screenshot; Manifesto chip, Product chevron, Docs arrow, divider |
| 12 | Duration units | Fixed | `docs/nit-265-ui-audit/detail-duration-local-fix.png`; step and timeline both say `370µs` |
| 13 | In-app Back history | Fixed | In-app Back returned to `?minMs=45`. Browser Back then showed the unfiltered list, and Forward returned to `?minMs=45` without restoring the detail first |
| 14 | Ingested time and detection count | Fixed | `list-histogram-pager-local-fix.png`; `11:47 PM` / `Oct 10` and `Execution Failed 2` now come from `ingestedAt` and a detection count |
| 15 | Expand all includes the root | Fixed | Expand all opened the four child spans and left the root span body closed |

Clear filters restored both rows. Applying `minMs=45` again left one exhausted row, matching that trace’s 51ms root and two detections. The recovered trace stayed at `6 STEPS · 0.043S`, `order_found`, and no detection pills.

## What was audited

| Item | Value |
| --- | --- |
| Branch | `codex/nit-265-replica-app` |
| Commit | `1bee18f0cc631fbf5febb89e64346f4c80abfde4` |
| Subject | `docs: hand off NIT-265 replica for Cursor continuation` |
| Worktree | `/Users/nitinkhanna/.codex/worktrees/8dc3/tailor-neathack` |
| Base recorded by the handoff | `9ba9a45f6d8fa916a56bcee31738ba57cc7e2b99` |
| Ahead of local `origin/main` | 5 commits, and this tip is only on this branch |
| Remote feature branch | not present locally (`origin/codex/nit-265-replica-app` does not resolve) |
| Linear NIT-265 | still Todo, no comments, last updated 2026-10-11T02:06:16Z, before this tip |

Verification on this follow-up: `git rev-parse HEAD` is still `1bee18f0cc631fbf5febb89e64346f4c80abfde4`. `git status` shows only untracked `docs/nit-265-ui-audit/` and this report. The local server already listening on `127.0.0.1:4321` was reused. No install, config, code, or official-project change.

The path named in the handoff was gone at the start of the first pass. This audit registered a worktree at that path with `git worktree add` so the existing commit could be read and served. That did not move the branch tip.

## Capture conditions

Evidence directory: `docs/nit-265-ui-audit/`. Theme: light. Zoom: 1. Device pixel ratio: 1.

**First pass, 2026-10-11 10:17–10:26 UTC.** PNG size 2688×1512. Official app stopped at sign-in (`auth-official.png`). Landing and the local fixture flows were captured at that size. The local landing CSS viewport measured 2673×1512 because of the scrollbar mismatch.

**Follow-up, 2026-10-11 10:58–11:08 UTC.** The signed-in Neatlogs panel captures at 1630×1298. Forcing a 2688×1512 device-metrics override still produced a 1630×1298 PNG and cropped the page, so that override was cleared. Official shots below are the natural panel. Local shots named `*-1630.png` used a 1630×1298 layout viewport inside the 2688×1512 panel, then were cropped to that viewport (inset about 17×15). The earlier 2688 local shots were not overwritten.

Official list URL, no secrets: `https://app.neatlogs.com/traces?orgId=8186e5df-b745-4e66-a01d-94c420459c43&projectId=a35a7334-258e-441c-b2e1-b8198a263f21&f=tags~tailor-demo-20261010-v1`. The app added `timezone=Asia/Calcutta` and a last-14-days range. Column positions were measured on the live page, not taken from an image description.

| File | State |
| --- | --- |
| `list-official.png`, `list-official-expanded.png` | Sandbox list, labeled sidebar open, light |
| `list-official-rail.png` | Same list, icon rail. Pair with `list-local-1630.png` |
| `list-empty-official.png` | Search `zz-no-fictional-trace`, tag filter still on |
| `list-local-1630.png` | Two fixture rows, icon rail |
| `list-empty-local-1630.png` | Same search, no rows |
| `detail-exhausted-official.png` | Scenario 06, graph and timeline off |
| `detail-exhausted-timeline-official.png` | Timeline on |
| `detail-exhausted-graph-official.png` | Graph and timeline on; detections are dots |
| `detail-exhausted-error-official.png` | First failed lookup expanded |
| `detail-recovered-official.png` | Scenario 03, graph and timeline still on |
| `detail-exhausted-default-local-1630.png` | Exhausted fixture, graph and timeline off |
| `detail-exhausted-timeline-local-1630.png` | Timeline on |
| `detail-exhausted-graph-local-1630.png` | Graph and timeline on; full gutter pills |
| `detail-exhausted-error-local-1630.png` | First failed lookup expanded |

First-pass files still in this directory: `auth-official.png`, `landing-official.png`, `landing-local.png`, `list-local.png`, `list-empty-local.png`, `list-latency-local.png`, the recovered local detail set, and the direct-link / unknown-trace shots.

## Visual mismatches

### Confirmed against the signed-in app

1. **Histogram bar fills the day.** Fixed. `docs/nit-265-ui-audit/list-histogram-pager-local-fix.png`. Official Oct 10 is a short gray block inside the track (`list-official-rail.png`, accessible name `Oct 10: 10 traces`). The replica paints the whole cell `#97979f` whenever any row matches (`list-local-1630.png`). Tick labels already match (Sep 28, Sep 30, Oct 2, Oct 5, Oct 7, Oct 9, Oct 11). Code: `i===12&&data.filtered?'populated'` in `list()` (`src/client.ts`) and `.day.populated{background:#97979f}` (`public/style.css`). Smallest correction: a child bar whose height follows the count. Do not add an Oct 10 text label; the official ticks omit it too.

2. **Synthetic notice covers the pager.** Fixed. `docs/nit-265-ui-audit/list-histogram-pager-local-fix.png`. At 1630×1298 the fixed notice sits on the bottom-right count. Official shows `1 - 10 of 10` clear of the sidebar (`list-official-rail.png`, `list-local-1630.png`). The wide-layout rule is `.demo-notice{position:fixed;bottom:4px;right:12px;z-index:3}` in `public/style.css`. Smallest correction: keep the notice in the document flow above the pagination row.

3. **An applied filter is not a selected chip.** Fixed. `docs/nit-265-ui-audit/list-filter-selected-local-fix.png`. Official shows a blue `Tags contains tailor-demo-20261010-v1` chip with a remove control (`list-official-rail.png`). The replica’s applied latency capsule stays the same white outline as an idle filter (`list-latency-local.png`, 2688). Code: `list()` only changes the Latency summary text; selected fill exists for an open popover. Smallest correction: an `is-selected` class on a summary whose query value is set.

4. **Graph-open detections stay full pills.** Fixed. `docs/nit-265-ui-audit/detail-graph-dots-local-fix.png` and `detail-graph-closed-local-fix.png`. With the graph closed, both products put “Execution Failed” in the left gutter (`detail-exhausted-official.png`, `detail-exhausted-default-local-1630.png`). With the graph open, official replaces those pills with small red dots (`detail-exhausted-graph-official.png`). The replica keeps the full pills (`detail-exhausted-graph-local-1630.png`, `detail-exhausted-error-local-1630.png`). Code: `spanRow()` always emits `<span class="span-detection failure">`, and `.span-detection` is `position:absolute; right:calc(100% + 45px)`. Smallest correction: when the graph is open, render a dot instead of the phrase.

5. **Graph kind icons.** Fixed. `docs/nit-265-ui-audit/detail-graph-dots-local-fix.png`. Official chain and workflow nodes are filled dark; guardrail, tool, and retrieval nodes are light and use different marks (`detail-recovered-official.png`, `detail-exhausted-graph-official.png`). Replica children use the tool icon unless the span is an error (`detail-exhausted-graph-local-1630.png`). Code: `icon(x.status==='ERROR'?'close':'tool')` in the graph markup in `src/client.ts`. Smallest correction: choose the icon and fill from `kind`, and keep the X for errors.

6. **Empty-state chrome.** Fixed. `docs/nit-265-ui-audit/list-empty-local-fix.png`. Both say “No traces found” and “Try adjusting your filters or date range.” Official adds a small document icon and a bordered Clear filters button (`list-empty-official.png`). The replica is the heading, the sentence, and a blue link (`list-empty-local-1630.png`). Code: the empty `<td>` in `list()` and `.empty a{color:#2766c7}`. Smallest correction: the icon and a button-styled clear control.

7. **Labeled sidebar is a second official shell.** Fixed. `docs/nit-265-ui-audit/list-sidebar-local-fix.png`. The icon rail matches the replica (`list-official-rail.png`, `list-local-1630.png`). Expanding it shows setup 1/2, console, chats, and experiments, and at 1630 it clips the Replay column (`list-official-expanded.png`; Replay’s header started at x=1614). The replica rail was a fixed 66px column in `shell()` with no toggle. The fix pass added an expand control. Expanded, it shows Synthetic demo, console, chats, setup 1/2, and the labeled project items including experiments. Unavailable items still toast and do not navigate.

### Landing, compared with the live public site

8. **Scrollbar and a narrower page.** Fixed. `docs/nit-265-ui-audit/landing-local-fix.png`. Official strip reaches the window edge. Local shows a classic scrollbar, and the strip’s right edge is page background. The footer is `position:absolute; top:100vh`, so the page scrolls, while `scrollbar-width:none` is set on `.landing` and `body:has(.landing)` but not on `html`. Screenshots: `landing-official.png`, `landing-local.png`. Smallest correction in `public/style.css`: stop the footer from growing scroll height, and hide the scrollbar on `html` as well.

9. **Hackathon strip.** Fixed. `docs/nit-265-ui-audit/landing-local-fix.png`. Both images read `Oct 10–12` and `$19,000`. Official is a 32px strip, fill about `(2,141,194)`, with the date in a rounded outline. Local is 31px `#008db3` with the date as plain text. Code: `landing()` in `src/client.ts`, `.hack` in `public/style.css`. Smallest correction: 32px, `#028dc2`, and a chip around the date only.

10. **Wordmark.** Fixed. `docs/nit-265-ui-audit/landing-local-fix.png`. Official is a compact mark starting further left. Local uses generic monospace at 30px with `letter-spacing:-1.3px` and `padding:12px 3vw`, so the mark is wider and further right. Geist Mono is already loaded for the setup control. Smallest correction: use that face for `.public-nav .wordmark` and reduce the nav’s horizontal padding.

11. **Nav chrome.** Fixed. `docs/nit-265-ui-audit/landing-local-fix.png`. Official Manifesto is a pale cyan pill with a cyan dot. Product has a chevron, Docs has an arrow, and a rule sits before the black button. Local is flat text plus the black pill. Code: the `public-nav` buttons in `landing()`. Smallest correction: draw the chip, arrows, and divider. Leave those destinations non-navigating.

The headline boxes match (about 1169px wide, tops one pixel apart). The setup control’s label, agent marks, copy chip, and cyan edge match in these stills. Motion was not compared.

### Internal replica inconsistency

12. **One step, two duration units.** Fixed. `docs/nit-265-ui-audit/detail-duration-local-fix.png`. Official step rows use microseconds for a sub-millisecond span and the official timeline has no duration labels. The replica step row prints `370µs` and the timeline prints `0.37 ms` (`detail-exhausted-timeline-local-1630.png`). The timeline label itself is a deliberate extra. The mismatch is the two formatters. Code: the `<time>` in `spanRow()` multiplies values under 1ms; the timeline always appends `ms`. Smallest correction: one duration helper if both surfaces keep a number.

## Functional defects

13. **In-app Back pushes history.** Fixed. In-app Back returned to `?minMs=45`; browser Back then opened the unfiltered list, and Forward returned to that filtered list. From the exhausted trace opened via `?minMs=45`, the in-app back control returns to that filtered list, because `returnTo` remembers the list URL. `navigate()` always `history.pushState`s, so browser Back then restores the detail, and Forward restores `?minMs=45`. A reload of the detail page clears `returnTo`, so the next in-app Back drops `minMs`. A reload of the list URL keeps the filter. Code: `returnTo`, `navigate()`, and the `data-nav` click handler in `src/client.ts`. Official in-app Back returned from scenario 06 to the tag-filtered list; the official history stack was not stepped. Smallest correction: if `.back-link` has a `returnTo`, call `history.back()`; use `navigate(base)` only when detail was opened directly.

14. **Ingested time and the detection count are literals.** Fixed. `docs/nit-265-ui-audit/list-histogram-pager-local-fix.png`. Every row prints `11:47 PM` / `Oct 10` instead of formatting `ingestedAt` (`2026-10-10T18:17:00.000Z`). That string matches the official rows in `Asia/Calcutta` and would be wrong in another zone. The detection cell prints `Execution Failed 2` whenever any span has `detection`. The exhausted fixture does have two detected errors, and official scenario 06 shows the same count, so these shots are numerically right. Code: `list()` in `src/client.ts`. Smallest correction: format `ingestedAt`, and count spans with `detection`.

15. **Expand all repeats the root.** Fixed. Expand all opened four child spans and did not open the root span body. `docs/nit-265-ui-audit/detail-duration-local-fix.png` shows the expanded children. No screenshot; the control is on every detail view. The handler adds every span id, including the root, whose input and output are already outside the card. Smallest correction: add only spans with a `parentId`.

The older-session URL in `detail-direct-link-error-local.png` is not a routing bug. A second local session replaced the HttpOnly cookie, and `authorize()` rejects any other id. After opening the cookie’s own session, direct trace URLs, reload, and `?span=` worked. `missing-trace` returns `NOT_FOUND: Trace not found in this session`.

## Deliberate scope exclusions

From NIT-265, `docs/nit-265-reference.md`, and the handoff. These are not defects. The follow-up confirmed the official counterparts.

- Hero and nav CTA say “Try with your project” instead of “Start free”. Marketing links toast and do not navigate. Below-the-fold marketing is absent.
- Two synthetic order lookups, not the sandbox’s 10-trace refund catalogue. Saved project text does not choose the fixture. Trace names and error sentences differ on purpose; layout was compared.
- Header duration stays on the root record (`5 STEPS · 0.051S`, `6 STEPS · 0.043S`). Official rounds those headers to `0S` while the row still says 51ms or 43ms (`detail-exhausted-official.png`, `detail-recovered-official.png`). That rounding is avoided on purpose.
- Evals stay empty. Official rows show “SYNTHETIC baseline” pills. Comments stay empty; official comments are a dash. Replay does not open a player.
- Sessions, Users, date, metadata, and advanced filters are unavailable controls. Search is a case-insensitive substring. Official search with a query said “Sorted by relevance”; sorting was not part of this slice.
- Column headers are not buttons. Official Ingested at sorts, and the other headers reorder columns. Measured order on the icon rail is Ingested at, Status, Detections, Evals, Input, Output, Comments, Replay, which is the replica order.
- The navigator is a two-trace picker. Official detail uses paged tabs of the 10-trace catalogue.
- Timeline labels include durations. Official timeline bars have no per-row duration.
- Graph is a fixed pane. Search, replay, comments, and Ask neat AI on the detail header do not run those products.
- Analytics, full auth, billing, assistant, and NIT-269 were not started.

## Unverified

These were not implemented. The fix pass did not add behavior for them.

- Official latency, workflow, detections, metadata, and advanced editors. The tag chip and its remove control were visible; those editors were not opened, and no saved view was changed.
- Whether official graph selection also highlights the step row. Locally it highlights the node and the timeline row only and does not change the URL.
- Official browser Back / Forward after in-app Back. Only the in-app control was used, and it returned to the filtered list.
- Ask neat AI toast. `detail-unavailable-toast-local.png` is byte-identical to `detail-span-link-local.png` (sha1 `b8426847c1d8e7f73b805420a361fa2847545910`) and shows no toast.
- Loading, dark theme, 390px, persistent backend failure, and a pixel-level hero-photograph diff.
- A local recovered detail recaptured at 1630×1298. The official recovered shot is `detail-recovered-official.png`. The local recovered set remains the 2688×1512 first-pass files.

## States inspected

| State | Result |
| --- | --- |
| Public landing, official and local | Inspected at 2688 |
| Sign-in | Past the wall on this follow-up. Sandbox list loaded |
| Official list, icon rail and labeled sidebar | Inspected at 1630, light |
| Official empty search `zz-no-fictional-trace` | No traces found; tag filter remained |
| Official scenario 06 default, timeline, graph, expanded error | Inspected |
| Official scenario 03 with graph and timeline left on | Inspected. One ERROR child, no Execution Failed pills |
| Official in-app Back | Returned to the tag-filtered list |
| Local list and empty search at 1630 | Inspected. Two fixtures; search copy matches |
| Local exhausted default, timeline, graph, expanded error at 1630 | Inspected |
| Local latency `minMs=45` | One exhausted row, at 2688 |
| Local recovered default, error, timeline, graph, graph select | Inspected at 2688 |
| Direct `?span=`, reload, unknown id, other-session URL | Inspected at 2688 |
| Unavailable toast, loading, date/session/user/eval editors, dark theme, mobile | Not captured |

List and detail agree on the local fixtures. Recovered: no detection, 43ms root, outcome `order_found`, order `SYN-ORDER-103`, one ERROR child. Exhausted: Execution Failed twice, 51ms root, escalation text that says no ticket was sent, two ERROR children. Official scenario 06 shows the same detection count and a 51ms root; scenario 03 shows a 43ms root and no detection pills. Fixture sentences are not the same text.

## Parallel fix plan

Do not start until review. Two owners, no shared files. The labeled sidebar waits, because it needs both files. Class names below are the contract between owners.

| Owner | File | Changes |
| --- | --- | --- |
| Landing and list chrome | `public/style.css` | Footer scroll and `html` scrollbar; 32px `#028dc2` strip; Geist Mono wordmark and nav padding; Manifesto chip, chevrons, and divider using classes `nav-current`, `nav-caret`, `nav-rule`; move `.demo-notice` above the pager; `.is-selected` fill for an applied capsule; histogram child bar height from a `--count` custom property, leaving the existing tick labels; `.span-detection.is-dot` for the graph-open marker; empty-state button styling |
| List and detail behavior | `src/client.ts` | Date chip markup; those nav classes; format `ingestedAt`; count detections; histogram bar element and `--count`; add `is-selected` when a filter value is set; one duration helper; graph icons and fills follow `kind`; when the graph is open, emit `span-detection is-dot` instead of the phrase; Expand all skips the root; `.back-link` uses `history.back()` when `returnTo` is set |
| Fixture contract | `src/fixtures.ts` | No visual change. Re-read only if a duration helper needs the stored `0.37` to stay the single source |

`public/assets/setup-prompt.css`, `src/server.ts`, and `src/store.ts` stay untouched for this pass.

## Entire capture

Skill used: `.agents/skills/entire-continuity/SKILL.md` on this commit. `entire doctor` and `entire status` were not run. Hooks were not edited. Entire CLI is 0.11.4.

Follow-up handoff check, `entire session current --json`:

| Field | Value |
| --- | --- |
| Session | `4a4e0ead-edae-4d72-9c11-9cf47062fc8b` |
| Agent | Cursor |
| Resolution | `caller-ambiguous` |
| Status | `idle` |
| Worktree | `/Users/nitinkhanna/Desktop/tailor-neathack` |
| Branch | `main` |
| `last_active` | `2026-10-11T16:26:33+05:30` |

The CLI said several sessions claimed the command and none could be ordered. Resolution is not `caller-env` or `ancestry`. The record is the primary checkout on `main`, not this worktree and not `codex/nit-265-replica-app`. Live capture for this follow-up is unverified. The handoff checkpoint `01M4N6EYWDZSBDYK5N9G2C7J10` is historical Codex evidence, not this Cursor session. No checkpoint was created here.

The three review sessions from the first pass (`2cc61e4c-f3fb-450b-8034-5c322b3e1c1f`, `720becc4-44df-4922-a8ed-1dc1914903fc`, `78a79fe8-9826-4489-81f3-040639930d4b`) were also `caller-ambiguous` on primary `main`.

Fix-pass check, same command, still `caller-ambiguous` and `idle` on primary `main`, not this worktree and not `codex/nit-265-replica-app`. `last_active` stayed `2026-10-11T16:44:54+05:30`. No commit was made, so no checkpoint was created. Live capture for the fix pass is unverified. Hooks were not edited.

## What this follow-up did not do

No implementation, dependency, configuration, git history, Linear, merge, deploy, push, amend, or force-push. The official sandbox was not edited: no project, key, trace, archive, setting, or theme change. NIT-269 was not started.
