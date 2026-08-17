---
section: Added
---

- **CUE Language Server support** — `.cue` files now resolve to a dedicated `CueServer` LSP entry launched via `cue lsp serve`, with `cue-lang/cue` registered as a managed GitHub-release tool for auto-install fallback. CUE is now a tracked `FileKind` with project/root markers (`cue.mod`), a diagnostic wait strategy, dispatch policy, and an LSP handshake fixture.
