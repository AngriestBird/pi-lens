---
section: Fixed
---

- **`mode=delta` no longer renders a file's quality (or project-diagnostics) rows under another file's header (refs #3196)** — `formatDeltaMode`'s quality loop and `appendProjectDiagnosticsDeltaLines` both suppressed a file's header with `if (!lines.includes(rel)) lines.push(rel)`, true whenever an earlier tier already pushed that exact path — but each tier's rows were appended to the END of the shared buffer, not under that earlier header. A file present in more than one report (actionable, quality, or project) had its later tier's rows, and any age/re-verify-incomplete label describing them, land under whichever OTHER file's header happened to be last in the buffer, misdirecting an agent acting on the finding. The render is now a single pass grouped by file: every tier appends into that file's own bucket, which makes the header-membership guess (and #3168's label-prediction dedupe) unnecessary — both are removed.
