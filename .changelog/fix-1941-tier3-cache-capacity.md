---
section: Fixed
---

- **Review-graph Tier-3 build never grew the tree cache past the 50-entry default (closes #1941)** —
  `builder.ts`'s full-project rebuild parses every non-jsts file through the
  shared `TreeSitterClient`'s parse-tree cache but never called
  `ensureTreeCacheCapacity`, the #1715 fix already wired into the
  diagnostics scanner. A project with more than 50 non-jsts files evicted
  and re-parsed files past the 50th on every Tier-3 build. The build now
  grows the cache to its actual per-parse working set before extraction
  starts — the full file list on a cold build, or the checkpoint's remaining
  files on a resumed build, since resumed files are reused from the
  checkpoint graph and never re-parsed.
