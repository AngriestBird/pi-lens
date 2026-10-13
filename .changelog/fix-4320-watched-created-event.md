---
section: Fixed
audience: user
---

- **A module created mid-session now clears the importer's missing-import (closes #4320)** — Language servers that cache a failed module lookup (Pyrefly) kept reporting `missing-import` and a definition at the import line after the module appeared, until the server restarted. pi-lens now announces a file born after the server started as Created instead of Changed, keeps Created when a Changed for the same file lands in the same batch, and no longer replays a cached finding that a newly created file may answer.
