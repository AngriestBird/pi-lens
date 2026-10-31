---
section: Fixed
audience: user
---

- **The cascade no longer reports neighbour errors computed for other file bytes**: the in-turn cascade showed "Cascade errors in N neighbor file(s)" for findings the language server computed against an earlier version of the file, while the diagnostics check already withheld them; the cascade now withholds those rows too, names the file as unconfirmed instead, and never reads the run as clean (#5051).
