# AGENTS.md

Tailor is a neatHack (October 2026) candidate. No application features yet.

## Setup

- Node >= 26.7.0, npm >= 11.19.0. Install with `npm ci`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — Node's built-in test runner (`node --test`, native TypeScript stripping).
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

- At task start and before claiming checkpoint continuity, use `$entire-continuity` from the maintained personal skill at `/Users/nitinkhanna/.codex/skills/entire-continuity/SKILL.md`. If discovery does not list it, read that file directly; the absolute path also works from this repository's linked worktrees. If unavailable on another machine, report that boundary and use `docs/entire-codex-worktrees.md` without claiming the skill was run. Do not create a conflicting repo-local copy.
- Verify the actual caller's session, worktree, state and fresh lifecycle evidence. Hook discovery/trust and an existing session ID alone do not prove live capture. The skill guides checks; it cannot guarantee hook execution or authorize mutations.
- After authorized commits, match exact commit, checkpoint and session IDs; after authorized pushes, verify the relevant local and remote checkpoint ref SHAs. Preserve commit identities, checkpoint refs and unrelated work.
- Distinguish local checkpoint linkage, historical/imported records, live session capture, remote sync and dashboard ingestion. Missing usage is unavailable, not zero; aggregate Analytics is not the success gate.
- For an on-demand weekly review, invoke the same skill on this repository's authorized work and report coverage limits. Do not create scheduled checks, import/attach history, amend, force-push, upload transcripts or change hooks/trust/authentication without the appropriate explicit authorization.
