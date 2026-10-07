---
section: Changed
audience: user
---

- Host pi-agent staging directories no longer start LSP servers, and real git checkouts under the temporary directory keep full analysis with a faster LSP idle teardown while their project data lives in a per-process directory that is removed when the process exits.
