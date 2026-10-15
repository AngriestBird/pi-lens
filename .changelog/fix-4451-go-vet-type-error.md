---
section: Fixed
audience: user
---

- **A Go type error or a Dart compile error is no longer reported as clean (#4451, #1937)** — `go vet` prefixes a type-check error with `vet: `, and the runner read that prefix as part of the file path, matched no target and returned `succeeded` with no findings. The prefix is now stripped before the path is compared. `dart analyze` exits 3 when it reports an error, but the runner's exit table stopped at 2, so the finding was dropped as a rejected run; the table now accepts 3. `tests/clients/dispatch/smoke-fixture-coverage.test.ts` now requires every dispatch runner to have captured real-binary output or a reasoned exemption, and `tests/clients/dispatch/runners/captured-real-output.test.ts` replays 14 more captured runners (Go 1.27.2, Dart 3.13.5 and others).
