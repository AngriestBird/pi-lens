---
section: Fixed
audience: user
---

- **A cascade neighbour whose language-server answer was computed for other bytes than disk is no longer reported as this edit's error**: the in-turn cascade showed "Cascade errors in N neighbor file(s)" for findings the server computed against an earlier version of the file, while the diagnostics check already withheld them; the cascade now withholds those rows too, names the file as unconfirmed instead, and never reads the run as clean (#5051).
