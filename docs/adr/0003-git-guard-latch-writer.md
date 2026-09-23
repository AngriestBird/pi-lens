# ADR 0003: git-guard latch is a separate writer

## Status

Accepted — 2026-09-23. Amended 2026-09-23 (#3248 remainder 2): the identity
rule below is decided and implemented.

## Context

The turn-end disposition policy can change the survivor set while the
git-guard latch is read first by the commit gate. Existing edit-time code writes
the latch and synchronizes the `turn-end-findings` record; turn-end policy was a
separate actor that did neither.

### Writers by axis, re-verified against the tree at `5f5d847f9`

| Actor | Axis / timing | Latch | Durable record | Site |
|---|---|---|---|---|
| `handleToolResult` | per edit, after each dispatch | `updateGitGuardStatus(result.hasBlockers, result.output)` | `syncGitGuardRecord(…, filePath)` | `clients/runtime-tool-result.ts:2546-2549` |
| `retireInlineBlockerAndResyncGuard` | confirmed-clean verdict from `lsp_diagnostics` | `updateGitGuardStatus(false, "")` | `syncGitGuardRecord(…, filePath)` | `clients/git-guard.ts:864` |
| `markGitGuardCacheUnknown` | cache/session mismatch, untrusted provenance, pipeline error | — | marks the record unreadable | `clients/git-guard.ts:749`, `clients/runtime-tool-result.ts:928` |
| turn-end composer, blocker sections | per turn, after policy | — | `writeGitGuardRecord` (dedupe path `:4231`, main path `:4287`) | `clients/runtime-turn.ts` |
| turn-end composer, clean session | per turn, when nothing survives | — | `clearCache("turn-end-findings")`, gated on the LATCH | `clients/runtime-turn.ts:829`, `:4379` |
| turn-end disposition policy (#3246) | per turn, per finding | **nothing — the gap** | nothing | `clients/runtime-turn.ts:1068` |
| `evaluateGitGuard` | read (commit gate) | reads the LATCH first and short-circuits | read second | `clients/git-guard.ts:1164` |

PR #3254's table named five actors; re-verification adds the composer's own two
record writers, which is what decides the rule below.

### State table

Axes: blockers on the file pre-policy / post-policy · record demoted by the
freshness sweep · persisted record freshness · which reader the gate uses ·
session identity.

| # | State | Latch | Record | Gate |
|---|---|---|---|---|
| 1 | every blocker on the only file suppressed | clear | cleared by the composer's clean-session clear (now reachable) | allow |
| 2 | 2 of 4 suppressed | set | blocker sections of the survivors | block |
| 3 | file X fully suppressed, file Y still blocking | set (Y) | Y only; X's summary gone | block |
| 4 | record demoted (`stale`) by the freshness sweep | set | untouched | block |
| 5 | every blocker suppressed, test failures in the record | clear | `hasBlockers` stays true via `testFailures` | block |
| 6 | suppressed, then an unrelated clean edit next turn | stays clear (the verdict rides the record the per-edit writer re-derives from) | not rewritten with the suppressed file | allow |
| 7 | suppressed, then a NEW blocker dispatched on the same file | set again | lists the new blocker | block |
| 8 | policy ran, suppressed nothing, changed no verdict | untouched | untouched | unchanged |
| 9 | record for a file that no longer exists (snapshot drops it) | untouched | untouched | unchanged |

## Decision

The latch is an aggregate over the inline-blocker MAP, and the map carries the
policy verdict. One identity rule, no second clause:

> A record is in the gate's blocking set unless the LAST turn-end policy pass
> found every blocker it carries suppressed.

- One writer for the verdict: the turn-end composer, at the point where the
  post-policy survivor set per file is final, calls
  `resyncGitGuardAfterInlinePolicy`, which stamps
  `InlineBlockerRecord.policySuppressed` on every live record (true for a fully
  suppressed file, false for every other, so a verdict cannot outlive its pass)
  and re-derives the latch through `updateGitGuardStatus(false, "")` — the same
  re-derivation the retire path uses.
- Two readers, both deriving from the map: the latch
  (`RuntimeCoordinator.updateGitGuardStatus`) and the persisted record
  (`syncGitGuardRecord`'s `blockerContent`). The per-edit writer therefore
  honors the verdict too, without a second identity clause.
- The record keeps the suppressed entry. The policy is content-bound and
  re-derived every turn end, so retiring the entry would be silencing rather
  than filtering (AGENTS.md shape 10), and a fresh dispatch replaces the record
  wholesale, so a new blocker is never born pre-suppressed (#1198 ordering).
- No third durable writer at turn end. The composer rewrites or clears the
  record later in the SAME turn end from the same survivor set, and its clear is
  gated on the latch this pass just recomputed.

## Consequences

The latch cannot be treated as a read-only projection of the blocker map.
Old-record parsing, the latch-first consumer, and the paired resynchronization
remain strict consumers of the next fix. `TurnEndFindingsCache` is unchanged by
this slice — the verdict is in-memory only, so a 4.2.1 commit hook reads records
written after a policy pass with no new field.

Clearing the latch exposes the gate's SECOND reader, which has its own defect:
`hasCompleteBlockingProvenance` parses `blockerContent` line by line while both
writers of that field render multi-line blocker text, so the gate answers
`blocking_provenance_untrusted` once a session has recorded any blocker —
measured on `origin/master`, independent of dispositions, and filed as #3282.

## Links

- Catalog shape: `AGENTS.md` shape 24.
- Issue: #3248.
- PR: #3254, “The git-guard latch” remainder and writers-by-axis table.
- Follow-up: #3282 (record provenance parse).
