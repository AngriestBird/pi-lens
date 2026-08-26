---
section: Added
---

- **Port 5 VTCode Go idiom rules (closes #2200)** — `go-no-fmt-println`, `go-no-panic-in-lib`, `go-no-underscore-func-name`, `go-prefer-errors-is`, and `go-prefer-string-builder` flag `fmt.Println`-family calls, library `panic()`, snake_case function names, direct error comparison, and repeated string concatenation. All five ship detection-only at their triaged severity (warning for `no-fmt-println`/`no-panic-in-lib`, hint for the rest) — each rewrite needs project or call-site context ast-grep cannot verify, so no `fix:` ships. The `+=` arm of `go-prefer-string-builder` is limited to string-literal operands because ast-grep has no type information. `go-no-global-variable` is excluded per the #2195 triage: valid package globals (constants, synchronization primitives) make it too noisy without project-specific policy.
