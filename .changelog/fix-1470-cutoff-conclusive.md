---
section: Fixed
---

- **A cut-off auxiliary no longer reads as confirmed clean (closes #1470)** — When
  the aux grace timer cut off a scanner such as opengrep, the touch still reported
  an unqualified confirmation, so a hung security scanner produced a result that
  read as a clean bill of health. The confirmation is now narrowed rather than
  discarded: it names the servers it does not speak for, so `lsp_diagnostics` says
  which coverage is missing, the cascade no longer wipes a live finding on that
  evidence, the workspace sweep stops caching a partially covered result, and the
  per-edit lane stops reporting an empty result as checked — on both the
  incumbent-touch route and the warm-attach route a per-edit check takes in a
  live session. A primary that
  answered stays trustworthy — its findings still reach you. A related gap stays
  open: a scanner that answers within its budget but publishes nothing still reads
  as clean (#1493).
