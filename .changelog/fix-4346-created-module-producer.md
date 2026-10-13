---
section: Fixed
audience: user
---

- **A module created outside pi-lens now clears its importer's missing import (refs #4346)** — A module written by a shell, `cp` or codegen reached no language server, so pyright and Pyrefly kept the importer's missing import for the server's life when only the importer was diagnosed. Before `lsp_diagnostics` answers, pi-lens now announces the files a finding-bearing importer resolves to, as Created to any server that has not heard of them. Workspace edits that create, rename or delete files now send their watched-file events too. The review graph adds the importer's edge for a newly created module, so a cached clean answer is refused when that module later changes.
