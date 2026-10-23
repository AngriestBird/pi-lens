---
section: Fixed
audience: user
---

- **A bash edit's dependent is no longer checked against its dependency's old bytes (refs #4782)** — When one command rewrote a module and a file that imports a name it added, the dispatch could read the importer's previous push answer, computed against the module's old bytes, while the server's newer answer was still in its 150 ms quiet window, and report a STOP on code that compiles. A diagnostics wait now never settles on a stored answer while a later one for the same file is pending.
