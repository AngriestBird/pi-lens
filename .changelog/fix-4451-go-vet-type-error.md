---
section: Fixed
audience: user
---

- **A Go type error is no longer reported as clean by `go vet` (#4451)** — `go vet` prefixes a type-check error with `vet: `, and the runner read that prefix as part of the file path, matched no target and returned `succeeded` with no findings. The prefix is now stripped before the path is compared. `tests/clients/dispatch/runners/captured-real-output.test.ts` replays bytes captured from Go 1.27.2 for both the prefixed and the analyzer shape.
