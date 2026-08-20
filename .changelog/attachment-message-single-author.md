---
section: Fixed
---

- **A size-capped write no longer says both "attached" and "too large to attach" ([closes #1590](https://github.com/apmantza/pi-lens/issues/1590))** —
  two layers used to phrase the post-autofix instruction. The pipeline claimed
  the attached content was authoritative whenever autofix changed the target
  file, and the tool-result layer, the only one that sees the 2 MiB attachment
  cap and the per-command aggregate budget, appended "you must re-read, the
  content is too large to attach" for that same file. A write whose post-fix
  content exceeded the cap carried both sentences, and a multi-file bash write
  past the shared budget did the same for the degraded path.

  The pipeline now returns the changed-file data instead of a verdict, and
  `handleToolResult` renders the one sentence from the one decision it owns.
  The shared budget is threaded into each synthetic per-file call, so a bash
  write decides each attachment once rather than attaching and then overruling
  itself. The telemetry follows: `authoritative_content_attachment_decision`
  logs one row per path, carrying `attached`, `size-capped`, or
  `aggregate-budget-degraded`, where a degraded path used to log two rows and
  rely on the later one winning.
