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
