---
section: Fixed
audience: internal
---

- Tests drain a log sink before reading its offset, line count or rows: `config-resolved-phase` and its session-wiring sibling took a `sessionstart.log` offset while their own lines were still queued (master run 38515888889), and the new `tests/config/sink-read-drain-sweep.test.ts` fails any test read of an in-process sink without an awaited drain of that sink right before it (#4381).
