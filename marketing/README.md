# Tailor website

Implementation of the approved Paper landing, Manifesto and How it works designs. The website is a self-contained ES-module application with a dependency-free Node server. Marketing assets and styles are loaded only on the three marketing routes. The Neatlogs application, provider configuration and session store are unchanged.

## Local review

```sh
cd marketing
TAILOR_DEMO_ORIGIN=http://127.0.0.1:4328 npm start
```

Open `http://127.0.0.1:4348`. Website routes are `/`, `/manifesto` and `/how-it-works`. Every demo CTA goes through `/try-demo`, which redirects to the configurable demo entry route (default `/entry`). The server forwards the existing demo routes, APIs and assets to `TAILOR_DEMO_ORIGIN`. Cookies, request bodies, query strings, Host and Origin are preserved; Tailor and the demo run under one browser origin. The demo server must already be running.

Configuration:

- `PORT`: website port, default `4348`.
- `TAILOR_DEMO_ORIGIN`: existing loopback HTTP demo origin, default `http://127.0.0.1:4328`.
- `TAILOR_DEMO_ENTRY_PATH`: relative demo entry route, default `/entry`.

The application intentionally binds to loopback only. Public hosting is outside this change. In production the hosting owner should route marketing pages and demo/API paths under the approved public origin.

## Integration boundary

This directory can be added independently to the demo repository. Start its server alongside the existing demo runtime. No shared demo styles, source routes, provider settings or spending ledgers are patched. It was based on the core review snapshot `1178c411f3169e4997f4bcf4f6c0f27a852d00c9`; proxying does not freeze that server's implementation. The core owner remains responsible for merging and runtime changes.

The existing demo's internal “Back to landing” link returns to the Neatlogs landing within its own client router. Browser Back returns to Tailor. A changed internal return link belongs to a separate core-owner integration decision.

Engineering tabs are interactive. Page examples are explanatory; live buyer exploration occurs in the connected demo. Product knowledge is described as versioned capability records ranked by keywords, not as a graph database. Session memory is temporary and separate from persistent product knowledge.

## Validation

`npm test` runs isolated server and proxy contract tests with a fake upstream. `tests/browser-review.mjs` uses the demo repository's Playwright package (or `PLAYWRIGHT_PACKAGE` override) to verify all pages and the CTA handoff in a private browser context. It blocks non-read requests so automated website review makes no paid model calls or telemetry ingestion. Screenshots and review output live under `tests/evidence` when run. Testing real buyer questions uses the existing demo's configured provider and budget.

Design source: https://app.paper.design/file/01M4J3ZRFTDES668P3Y5WR4FEX/p-A-0

## Agent animation

The How it works page includes a 24-second explanatory animation from the approved [motion storyboard](https://app.paper.design/file/01M4J3ZRFTDES668P3Y5WR4FEX/p-B-0). It starts paused. Play/pause and replay control one sculptural SVG folio: curved context leaves fan apart, fold into a bounded action, and open into the verified result; previous/next and eight directly selectable chapter marks support live narration. Arrow keys and Home/End work within the playback controls. Background tabs pause playback. Reduced motion uses static step changes and never starts a timer.

This is a fictional illustration, not live execution status. Context pruning leaves session state intact. Sonnet 5.5 is the current model, with guard low and planner/explain medium effort. Validation, save and independent readback occur in order before the verified answer. The final scene is a labelled time jump: End demo or server-clock expiry clears demo conversation/data, while hosted runtime telemetry retains its separate lifecycle. No hosted retention duration is claimed. The module makes no API requests or model calls.

For a marketing-only preview without a demo connection, use `PORT=4368 TAILOR_DEMO_ORIGIN=http://127.0.0.1:1 node server.mjs`, then open `/how-it-works#motion-title`. Existing demo CTAs report unavailable on this isolated preview; the animation itself is independent of the backend.

Run `TAILOR_TEST_URL=http://127.0.0.1:4368 npm run test:motion` against the preview. Set `PLAYWRIGHT_PACKAGE` to an installed Playwright module if the existing review environment is unavailable. The browser review verifies movement across frames, frozen geometry on pause, resume/replay, ordered readback, narration/keyboard controls, one-shot completion, reduced motion, other-page isolation, and no overflow at 1440/980/390/320px. Generated screenshots and JSON evidence are ignored under `tests/evidence/motion/`.
