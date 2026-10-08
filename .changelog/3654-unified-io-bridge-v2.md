---
section: Added
audience: user
---

- **A unified file I/O lifecycle bridge for extensions (refs #3654)** — Extensions that report file reads, edits, writes, and deletions out-of-band can now call one bridge at `Symbol.for("pi-lens:io-bridge")` (`version: 2`). A combined edit-and-preview call is recorded atomically (the edit first, then the read), a read with no supplied content is now coverage-only instead of re-reading the file from disk, deletes evict the file from the read guard and tell language servers it is gone, and a file queued for deferred formatting is announced on `pi.events` before it is rewritten. The legacy `pi-lens:read-bridge` and `pi-lens:mutation-bridge` symbols keep their call shapes and return values and run the same bookkeeping as the new bridge; a legacy read of a file that no longer exists now records nothing.
