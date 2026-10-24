---
section: Fixed
audience: user
---

- **A bash command that rewrites a module and its importer no longer STOPs on the importer's stale error.** Pyright and typescript-language-server checked the importer against the module's old bytes and re-checked it only after pi-lens had read the answer. pi-lens now sends each document of the command to them again after the last one, and reads the answer to that send (#4782).
