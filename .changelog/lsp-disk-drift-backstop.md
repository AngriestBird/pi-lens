---
section: Fixed
---

- **Heal the LSP view after an untracked disk edit** — An edit made outside
  the tracked write/edit path, such as a bash-tool bulk edit, sent no
  `didChange`, so the language server kept publishing pre-edit diagnostics
  indefinitely. pi-lens now records what content actually landed on each
  server and, on a bounded cadence, compares disk size and mtime against that
  record. A document whose bytes really changed is re-pushed within 10 seconds
  of the next LSP activity, to every server holding it — the primary language
  server and the auxiliary scanners alike. The sweep stats at most 64 documents
  per pass
  (1.7ms measured), reads only the ones whose stat diverged, and issues at
  most 4 resyncs per pass so a bulk edit heals in paced rounds.
