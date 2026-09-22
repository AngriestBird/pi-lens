# ADR 0003: git-guard latch is a separate writer

## Status

Accepted — 2026-09-23

## Context

The turn-end disposition policy can change the survivor set while the
git-guard latch is read first by the commit gate. Existing edit-time code writes
the latch and synchronizes the `turn-end-findings` record; turn-end policy was a
separate actor that did neither.

## Decision

Treat the git-guard latch as a second writer on the durable record. Its own
slice must start from the writers-by-axis table and recompute the latch and
record together after turn-end policy.

## Consequences

The latch cannot be treated as a read-only projection of the blocker map.
Old-record parsing, the latch-first consumer, and the paired resynchronization
remain strict consumers of the next fix.

## Links

- Catalog shape: `AGENTS.md` shape 24.
- Issue: #3248.
- PR: #3254, “The git-guard latch” remainder and writers-by-axis table.

