---
type: fix
issue: 2324
---

Keep the ast-grep NAPI fallback active until the auxiliary LSP completes its
first diagnostic publication for the root, preventing silent findings loss
during startup and non-publication windows.
