# Entire capture check

## Purpose

Verify that Entire (CLI 0.11.4) captures a real Cursor agent session in this
repository through `.cursor/hooks.json` and the Entire git hooks, and that a
commit made in that session gets an `Entire-Checkpoint` trailer and checkpoint
data.

Earlier sessions in this repository were **not** captured; this document makes
no claim about them.

## Runtime

- Commit title says "Cursor desktop", but this check ran as a Cursor Cloud
  Agent on a **self-hosted worker** on Nitin's Mac (workspace root
  `~/Desktop/tailor-neathack`, branch `setup/local`), not an interactive
  Cursor desktop chat.
- Session ID: `bc-c90a0f23-c08a-5fc1-9aa8-d0758e15f26d`, model
  `claude-opus-5-5-medium`.
- Node v26.7.0, npm 11.19.0, Entire CLI 0.11.4 (go1.27.1, darwin/arm64).

## Commands and results

| Command | Result |
| --- | --- |
| `entire version` | `Entire CLI 0.11.4` |
| `entire status --detailed` (before commit) | Enabled on `setup/local`, agent Cursor, checkpoints sync to `origin`; 1 active session (this one) with this session's prompt |
| `npm run typecheck` | exit 0, no errors |
| `npm test` | exit 0, 2 tests, 2 pass, 0 fail |
| `npm run doctor:local` | exit 0, overall `pass`, all 7 checks `pass` |

## Hook evidence observed before commit

- `.entire/logs/entire.log` records `turn-start` (agent `cursor`) and the
  `idle -> active` phase transition for this session, so the
  `beforeSubmitPrompt` hook fired from the worker.
- `.entire/metadata/<session>/prompt.txt` contains this session's prompt.
- The `session_ref` transcript path Entire logged
  (`~/.cursor/projects/Users-nitinkhanna-Desktop-tailor-neathack/agent-transcripts/<session>.jsonl`)
  did **not** exist on disk at that time; the worker does not write a local
  transcript JSONL there. Checkpoints from worker sessions may therefore hold
  the prompt and changed files but no full transcript.
