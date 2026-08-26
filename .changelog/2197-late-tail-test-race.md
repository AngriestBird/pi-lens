---
section: Fixed
---

- **Deflake the output-cap tail-retention test (refs #2197)** — Let the child ignore SIGTERM so the cap's kill cannot settle it before it emits its last line. On POSIX a child's pipe writes are asynchronous, so the cap kill could destroy queued output the assertion needed.
