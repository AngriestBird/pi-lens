---
section: Fixed
audience: user
---

- **A bash command that rewrites a Python module and its importer no longer STOPs on the importer's stale error.** Pyright checked the importer against the module's old bytes and re-checked it only after pi-lens had read the answer. pi-lens now sends each document of the command to Pyright again after the last one, and reads the answer to that send (#4782).
