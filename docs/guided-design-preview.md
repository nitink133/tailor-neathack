# Contextual guidance design preview

This is an isolated, scripted design fixture for review. It does not change the production browser client, agent prompts, provider, structured-answer contract, or persistence. It makes no live Claude or Jev claim.

Open `http://127.0.0.1:4326/assets/guided-preview.html` while the local mock server is running. Start it from this worktree with:

```sh
npm run build
PORT=4326 TAILOR_PROVIDER=mock TAILOR_TELEMETRY=captured TAILOR_DATA_PATH=.local/design-preview.sqlite node src/main.ts
```

The command does not load `.env.local`. The preview itself makes no agent or telemetry requests.

## Review scope

Review the relationship between the buyer's answer, its short purpose-led suggestions, and one selected UI target. Check dismissal, ordinary navigation, a missing target, and a changed scenario. There is no compulsory linear tour. The preview uses lookup and support-output fixture targets; it does not invent a model-call or comparison target.

The existing guide has useful grounded span links and bounded ancestor reveal, but its generic, small workspace strip is visually distant from the answer. This preview tests moving guidance next to the answer while retaining Neatlogs' neutral surfaces, borders, font, and visible Tailor attribution.

## Approval boundary

Stop for Nitin's visual and interaction feedback before implementing the later agent contract. The proposed later contract would select structured guidance with the answer and validate it against adapter-owned targets and the current rendered state. That pipeline is not implemented here.

## Provenance

Branch: `codex/tailor-guided-design-preview`.

Worktree: `.claude/worktrees/tailor-guided-design-preview`.

Base: `3d91d542a720854dd0086aeed5342aa1b4fca09a`. A fresh `git ls-remote` matched this exact SHA on `origin` branch `codex/tailor-20261012-review-fixes`; stale main was not used. Existing branches, worktrees, and servers were preserved.

The inspection, UI implementation, and independent review agents all used the inherited GPT-6 model. Entire 0.11.4 identified caller `01a12f26-8424-749c-adff-b171d9f5d048` but reported no session state. Live capture is unverified; usage is unavailable. No hooks, trust, credentials, or history were changed to manufacture capture.

## Verification

- `npm run typecheck`, `npm run build`, JavaScript syntax, and `git diff --check`: passed.
- Focused guide/cache tests: 6 passed. The cache test needed permission for a local listener; it passed when rerun with that permission.
- `npm run test:ui -- ui/guided-preview.spec.ts`: 5 passed. Checks single/repeated selection, dismissal/Escape focus, ordinary navigation, one/two relevant suggestions, missing-target recovery, changed-scenario recovery, and 1440×900 / 390×844 layout.
- Actual Chrome interaction verified selection, repeat clicks, dismissal focus, missing-target recovery, and stale-scenario recovery. Saved desktop/narrow pixels were inspected.
- Screenshots: `guided-preview/desktop.png`, `guided-preview/narrow.png`.

Browser QA caught inline-script blocking by the existing Content Security Policy; moving the script into a local asset fixed it without weakening the policy. Independent review caught stale-scenario timing/output consistency and recovery focus; both were corrected before the passing checks. Existing reported full-suite baseline checks were not rerun.

No paid model calls, hosted telemetry, credential changes, deployment, push, merge, or new agent contract were performed. The review server on 4325 was preserved. The localhost preview process remains on 4326 for feedback.
