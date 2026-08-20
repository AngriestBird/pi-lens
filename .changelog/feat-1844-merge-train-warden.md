---
section: Added
---

- **Merge-train warden (refs #1844)** — A scheduled workflow now sweeps every open PR every 10 minutes and mechanizes what a human was doing by hand during the release drive: label and comment once (deduped) when a PR turns merge-conflicted (`mergeStateStatus: DIRTY`), call the native update-branch API when an armed auto-merge PR falls behind, and label and comment once (deduped) when a required check (`Unit tests`, `Lint & type-check`) fails on the current head. It never resolves conflicts, merges, or pushes to a PR branch. A new fast-fail CI job validates `.changelog/` fragments in under a second, ahead of the full Unit-tests lap, so a malformed fragment fails fast instead of after a full suite run.
