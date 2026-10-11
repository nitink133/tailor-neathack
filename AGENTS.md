# AGENTS.md

Tailor is a neatHack (October 2026) candidate. The current slice is a mock-backed, server-side product agent inside a limited Neatlogs replica; see `docs/nit-269-handoff.md` for what works, what is mock-backed and what needs approval.

## Setup

- Node >= 26.7.0, npm >= 11.19.0. Install with `npm ci`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — Node's built-in test runner (`node --test`, native TypeScript stripping).
- `npm run build` — browser bundle (`tsconfig.browser.json`); `npm run dev` builds then runs `src/main.ts` (composition root; env in the handoff doc).
- `npm run test:ui` — Playwright against a throwaway server on port 4322 (mock provider, captured telemetry).
- `TAILOR_PROVIDER` accepts only `mock`; `TAILOR_TELEMETRY=neatlogs` needs `NEATLOGS_API_KEY` in the shell and is an approval gate (external ingestion). Never make live model calls or export telemetry externally without explicit approval.
- `npm run doctor:local` — Neatlogs SDK Doctor, local mode (network-free, deliberately does not load `.env.local`).
- `npm run doctor:probe` — authenticated Doctor probe; loads `.env.local`.
- `npm run smoke:trace` — sends one SYNTHETIC trace (no model calls) and reads it back by ID; loads `.env.local`. Each run creates a trace in the Neatlogs project.
- `npm run env:check` — reports only whether `NEATLOGS_API_KEY` is set, never its value.

## Local secrets

- Put secrets in `.env.local` (gitignored, `chmod 600`). Scripts that need them run `node --env-file-if-exists=.env.local …` directly; Node rejects `--env-file*` in `NODE_OPTIONS`, so `npm exec` cannot pass it to the CLI.
- Shell-exported variables take precedence over `.env.local`.
- Never `cat`, read, print, or log `.env.local` or the key; use `npm run env:check`.

## Rules

- Secrets live only in the environment or a gitignored `.env.local`; `.env.example` holds placeholders. Never print, log, or commit `NEATLOGS_API_KEY`.
- `neatlogs` is pinned to an exact version; upgrade deliberately, never downgrade.
- Do not run `neatlogs doctor --probe` until the Neatlogs project and region are confirmed and the key is set.
- Entire captures Cursor sessions via `.cursor/hooks.json` and git hooks; keep `.entire/settings.json` and `.cursor/hooks.json` tracked and preserve unrelated hooks.

## Entire session and checkpoint continuity

- At task start and before claiming checkpoint continuity, use `$entire-continuity` from the maintained project skill at [`.agents/skills/entire-continuity/SKILL.md`](.agents/skills/entire-continuity/SKILL.md). If discovery does not list it, read that file relative to this checkout's root. Linked worktrees need the approved skill commit in their own checkout; do not copy from or mutate another active worktree. If this checkout lacks the skill, report that boundary and use `docs/entire-codex-worktrees.md` without claiming the skill was run. Keep the skill repository-scoped, with no global duplicate.
- Verify the actual caller's session, worktree, state and fresh lifecycle evidence. Hook discovery/trust and an existing session ID alone do not prove live capture. The skill guides checks; it cannot guarantee hook execution or authorize mutations.
- After authorized commits, match exact commit, checkpoint and session IDs; after authorized pushes, verify the relevant local and remote checkpoint ref SHAs. Preserve commit identities, checkpoint refs and unrelated work.
- Distinguish local checkpoint linkage, historical/imported records, live session capture, remote sync and dashboard ingestion. Missing usage is unavailable, not zero; aggregate Analytics is not the success gate.
- For an explicitly requested weekly evidence review, invoke the same skill on this repository's authorized work and report coverage limits. Do not create scheduled checks, import/attach history, amend, force-push, upload transcripts or change hooks/trust/authentication without the appropriate explicit authorization.
