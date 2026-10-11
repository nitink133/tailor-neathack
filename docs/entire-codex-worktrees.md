# Entire capture in Codex worktrees

This guide targets Entire **0.11.4**. Its [Codex integration contract](https://github.com/entireio/cli/blob/v0.11.4/cmd/entire/cli/agent/codex/AGENT.md) tests CLI/app-server hook discovery against Codex 0.149.0. Lifecycle hooks capture turns and rollout evidence; ordinary Git commits link checkpoints.

For a fresh verification, configure and approve hooks before starting a new Codex session in the intended worktree. Before editing, run:

```sh
entire session current --json
entire status --json
entire doctor </dev/null
```

Require the caller's session ID, actual `active` state, correct branch/worktree, enabled tracking, healthy Git hooks, active Codex hooks and present approval records. An ID alone is insufficient; do not attach/import old history to manufacture proof.

Conventional linked worktrees discover the primary checkout's `.codex/hooks.json`. Thus `worktree_path_not_discovered` can coexist with doctor reporting `ACTIVE (via root checkout)`. Check the discovered path and trust. A future linked worktree also needs its own `.codex` project layer; a worktree created from a branch without that directory may need approved local integration setup. Review any untrusted hooks through Codex `/hooks`, then start or resume a session and repeat the checks. Entire owns writes only to the current checkout; preserve unrelated hooks. Keep `.entire/settings.json`, `.cursor/hooks.json` and `.codex/hooks.json` tracked, and ignore nested worktrees with `/.claude/worktrees/`.

Commit normally; let Git hooks create the `Entire-Checkpoint` trailer. Verify locally with:

```sh
entire session info <session-id> --json
entire checkpoint list --session <session-id> --json
entire checkpoint explain --commit HEAD --json
```

Match the commit, checkpoint and session IDs. Missing usage means unavailable evidence, not zero tokens; report zero only when recorded explicitly.

The [0.11.4 storage and sync reference](https://github.com/entireio/cli/blob/v0.11.4/README.md#checkpoint-remote) describes separate checkpoint refs and normal push syncing. With checkpoint pushing enabled, the pre-push hook syncs to the elected remote shown by `entire status`. Review transcript-derived checkpoint blobs for secrets before an authorized normal push; never manually push shadow branches.

Local Git linkage proves local capture. Dashboard visibility additionally requires successful remote sync and ingestion; it must be checked separately. Keep credentials and private transcript content out of documentation.
