---
section: Added
audience: user
---

- **Declare which runners a custom LSP server subsumes (`lsp.servers.<id>.covers`)** — A user-registered language server can now name the dispatch runner ids it owns (`covers: ["shellcheck"]`): while that server is a file's primary LSP, the named runners defer to the warm lane (`covered-by-primary`) instead of double-running. A covers member that is not a recognized runner id is dropped with a `PILENS_CFG_0005` warning naming the entry — the server itself still registers — and the claim and its source render in `effective_config`. Completes the #3968 ownership story started by the dialect-aware ShellCheck runner: registering a zsh-aware shell LSP with `covers: ["shellcheck"]` replaces the per-project rule-filter workaround with one config line.