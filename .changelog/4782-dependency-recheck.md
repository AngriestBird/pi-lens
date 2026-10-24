---
section: Fixed
audience: user
---

- **A bash rewrite of a module and its importer no longer STOPs on the importer's stale error.** Pyright and typescript-language-server checked the importer against the module's old bytes and re-checked it only after pi-lens had read the answer. pi-lens now sends each document of the command to them again after the last one, and reads the answer to that send. A server run through an `lsp.serverOverrides` command gets no second send, because pi-lens has not measured that binary (#4782).
