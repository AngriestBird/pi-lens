---
section: Changed
audience: internal
---

- Move 43 of the last 46 `clients/lsp/capabilities` test files off `vi.mock`/`vi.doMock` and onto `tests/support/lsp-service-seam.ts` (a no-service install and a `beforeReset` hook added to the seam), deleting their `in-process-mock` and `vi-mock-export` baseline rows; three files stay with their reason (#4709).
