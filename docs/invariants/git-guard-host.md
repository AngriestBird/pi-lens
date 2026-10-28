<important if="touching git guard and host adapters rules">

### Git guard and host adapters

- Git command classification has one lexer and one guarded-verb matcher seam.
  Unknown wrappers and indirect guarded verbs fail closed. Text-consumer
  allowances recurse through command substitutions and execution contexts. A
  substitution's output is read both empty and opaque (shape 61).
- The commit gate reads two states: the inline-blocker map's latch
  (`RuntimeCoordinator`), then the persisted `turn-end-findings` record. A
  collect-later runner's blocking findings join the map through
  `clients/deferred-runner-blockers.ts`, never a second store: the turn-end
  late-runner lane records them before the blocker replay (so the replay is
  their one delivery and the composer persists them), and the gate judges
  answers that settled but no turn end has drained, then refreshes the
  persisted record (`syncGitGuardRecord`) as the inline path does at
  `tool_result`. Both sites call one verdict, `judgeDeferredRunnerFindings`
  (freshness, then policy), and the record's `sources` and `lines` come from
  `clients/inline-blocker-fields.ts`, shared with the pipeline's writer. A run
  still in flight does not gate, and an edit to the file while its re-check is in
  flight clears the record until that answer settles (#3814). The gate and the
  record's writers in `clients/git-guard.ts` and the turn-end composer read it
  at any age. Each blocker section keeps the session that wrote it (top-level
  `sessionId`, other owners in `carriedBlockers`; a record without that field
  is one owner's), and a writer replaces only its own session's sections.
  Another session's section leaves only for a file a dispatch checked
  whole and found clean (`checkedWholeFile`), or whose file is gone. Its text
  no file owns (a project lane's report: CVEs, secrets, cascade) leaves only
  when its owner rewrites it, or at a turn end once `DEFAULT_MAX_AGE_MS` has
  passed since its owner's own write (`blockerWrittenAt`, per partition; the
  record's own timestamp moves with every writer). A record written before
  this version has no stamp: the first turn end of another session that
  carries it (a composer write or a settled turn end) writes one, and its
  window starts there. Only a write logs what it drops. The gate judges a
  record alone only when this session is its sole owner. A settled turn end
  drops this session's sections and another session's expired text no file
  owns, and retires a record that is this session's own, claims no blocker, or
  holds no structured claim (the `--lens-guard`-off writer's), with one
  `record_retired` row (#4725). A dispatch that never answered
  (`pipeline_crash`, `pipeline_error`) is latched per file, apart from the
  record's latch, and only that file's own returning dispatch clears it.
- Inline blockers have owners (#4921). A blocker belongs to the turn session
  whose write recorded it; a record with no `session` is the coordinator's.
  The commit gate reads every record, whoever owns it, because the tree is
  shared. A turn end reads only its own session's records: it delivers,
  sweeps, re-judges and consumes those, and files its guard section under its
  own id. Only a write by the coordinator's session latches
  `session_mismatch`; a concurrent session's write leaves another
  session's record and the latch alone.
- The commit gate is keyed by the repository being committed (#4941), not by
  session. A commit/push is judged by the unresolved blockers whose files lie
  in the git checkout it targets (`resolveGitCheckout`, the seam the review
  graph and the analysis root use; a linked worktree is a checkout of its
  own), whoever wrote them. This covers every reader the gate has: the
  inline-blocker latch memo, the stale-suppression scan, the dispatches that
  never answered, and the record-failure latch (marked with the project it is
  about). A sub-agent committing in repository B is not refused for a blocker
  in repository A; one committing where the blocker is still is. The
  target comes from `resolveCommitScope` and fails closed: only plain `git`
  segments (global option `-C <existing directory>` only) beside a short list
  of neutral commands (`echo`, `tail`, ...) are placed in a tree. `cd`, an
  assignment, `--git-dir`, `--work-tree`, `-c`, a wrapper, a substitution that
  runs git, any other command in the chain, or a directory outside a checkout
  leaves the command unscoped, and an unscoped command, a latch or verdict
  that names no file or project, and a caller that passes no command are
  judged by every blocker. The persisted `turn-end-findings` record stays the
  committing session's project's (`cwd`).
- The shared-checkout guard refuses unsafe worktree mutation when another live
  session and uncommitted work are both proven. It never auto-stashes.
- `mcp/server.ts` talks to pi-lens through `clients/lens-engine.ts`. A mirrored
  capability is one engine method plus one route. MCP transport remains
  hand-rolled and dependency-free.
- Host SDK imports are type-only, except the one lazy, caught lookup of pi's
  `withFileMutationQueue` in `index.ts` (#3506), admitted by count in
  `tests/host-sdk-type-only.test.ts`; `clients/file-mutation-queue.ts` detects
  and records a second SDK copy. Runtime dependencies belong in
  `dependencies`.

</important>
