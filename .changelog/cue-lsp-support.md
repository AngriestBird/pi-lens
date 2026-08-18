---
section: Added
---

- **CUE Language Server support** — `.cue` files now resolve to a dedicated `CueServer` LSP entry launched via `cue lsp serve`, with `cue-lang/cue` registered as a managed GitHub-release tool for auto-install fallback. CUE is a tracked `FileKind` with project/root markers (`cue.mod`), dispatch policy, and an LSP handshake fixture. Coverage is syntax and parse diagnostics only: `cue lsp` leaves conflicting values and failed constraints to `cue vet`.
