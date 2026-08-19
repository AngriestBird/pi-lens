---
section: Fixed
---

- **Pull diagnostics no longer miss whole categories on multi-source servers** (#1667) — a server that registers `textDocument/diagnostic` once per diagnostic source (Roslyn: syntax, semantic, analyzers; vtsls) had every `registerOptions.identifier` discarded, so pi-lens issued one bare pull and never asked for the other sources. The client now pulls every registered source in parallel plus the bare request, answers on the first source with findings for the file, and merges slower sources into the cache in the background. Result-id inheritance (`kind: "unchanged"`) is tracked per source, a source retired by `client/unregisterCapability` no longer leaves its findings in the cache, and workspace-pull support is read from the registration's `workspaceDiagnostics` flag instead of guessed from the method name.
