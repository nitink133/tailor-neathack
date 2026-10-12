# Entire capture check

## Verification limit

This preserves the historical `setup/local` report from commit
`f8ccc96b454dc3d5e029065662fb2cf3e4b61b5b`; its reported observations
below have not been re-tested during consolidation. That commit references
checkpoint `01M4KAJT289SESENV3GP98AQVX`, which is absent from the local and
origin checkpoint refs inspected on 2026-10-11. Its checkpoint linkage and
remote continuity therefore remain **unverified**. No checkpoint was fabricated
or imported to fill that gap. For the later Codex worktree procedure, see
[Entire capture in Codex worktrees](entire-codex-worktrees.md).

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

## 2026-10-12 coverage update (NIT-269 branch)

This section is dated and factual. The historical `setup/local` report above is preserved unchanged. Sources: the peer-review coverage audit of 2026-10-12 03:11–03:15 IST (read-only), plus local `git log`, local `refs/entire/` and `.entire/logs/entire.log` observed on 2026-10-12 after `f326d2d`. Dashboard visibility was **not observed** (the Entire dashboard was not opened). Nothing was imported, attached, amended, force-pushed or re-hooked, and no trailer was manufactured.

### Historical finding (preserved)

Of the 19 commits in `bbb2600..8dd4b9d`: **4 of 19 are synced** (checkpoint ref present and equal locally and on `origin`: `be40620`, `ea49c83`, `868ee68`, `c0a7a71`, session `c3f24fda`); **5 are trailer-only** (`Entire-Checkpoint` trailer present but no checkpoint ref locally or on `origin`: `f34adb3`, `7736bf5`, `bd6181b`, `b676d14`, `faaa0ab`); **10 have no trailer** (including `97f377b` and `8dd4b9d`). For `f34adb3` the log shows the transcript file was not ready and the session was skipped; the cause for the other four trailer-only commits was not established. Entire's `checkpoint explain` attempted a remote fetch for the missing checkpoints and created no refs.

### Commits since `8dd4b9d`

| Commit | Trailer | Checkpoint ref (local) | Session | Class |
| --- | --- | --- | --- | --- |
| `6bfcdf8` | `01M4PJ0SBZ2XBHF6RQP00XZYWY` | present: `refs/entire/checkpoints/WY/01M4PJ0SBZ2XBHF6RQP00XZYWY` → `d78c011` | `b60932a1` (caller-env) | local checkpoint linkage; the log shows `session condensed` at 04:11:00 IST. Remote ref equality was not checked. |
| `bfdb66e` | `01M4PKHN1K55CREEYCRXGTSTNF` | **not present locally** | `b60932a1` | **trailer-only**: the log shows `prepare-commit-msg: trailer added` at 04:37:41 IST but no `session condensed` line followed. |
| `f326d2d` | none | n/a | n/a | **no trailer** |

### Observed cause (hook log)

Entire's Cursor hooks attribute only files edited by the **orchestrator session** (`b60932a1`). Work done by subagents was not attributed to it. The log records the lifecycle message `no files modified during session, skipping checkpoint` (agent `cursor`; several entries, the latest at 2026-10-12 03:12:56 IST, logged against session `c3f24fda`). Commits whose edits came from subagents therefore tend to get no trailer, or a trailer without a checkpoint. That attribution rule, and its mapping to `bfdb66e` and `f326d2d`, is an inference from the log and the session behaviour, not a confirmed root cause.

The Cursor **transcript-path mismatch persists**: Entire records `agent-transcripts/<id>.jsonl` while Cursor writes `agent-transcripts/<id>/<id>.jsonl`. It has not been repaired (no symlink, copy or session-state edit) and should be reported upstream to Entire (CLI 0.11.4).

### Not done

No amend, no import of historical transcripts, no `entire session attach`, no manufactured trailer or checkpoint, no hook, trust or authentication change. The 15 earlier commits without a verified checkpoint, and `bfdb66e`/`f326d2d`, remain as above; closing the gap would need explicit approval, and permission to import is not permission to rewrite pushed history. Checkpoint usage figures are unavailable where not recorded; they are not zero.
