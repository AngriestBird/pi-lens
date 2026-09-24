---
section: Fixed
---

- A child process that writes without limit can no longer terminate the Pi
  host. `safeSpawnAsync` now caps retained output at 32 MiB when the caller
  passes no `maxOutputBytes` — 98 of its 110 call sites passed none, and an
  absent cap grew one JavaScript string until V8 threw `RangeError: Invalid
  string length` from inside a stdout/stderr `data` handler, where no caller's
  `try`/`catch` could reach it. The noisy child is now truncated, terminated
  and reported through the existing `outputTruncated` / `killedForOutputCap`
  result, and any other fault in that handler becomes the same bounded result
  instead of an uncaught exception. A ledger row names the command, the cap,
  the bytes observed and whether the child was terminated (closes #3375).
