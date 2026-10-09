---
section: Changed
audience: internal
---

- One LSP server-role vocabulary and a declared trait table (refs #1488, refs #1756): `LSPServerInfo.role` is now non-optional, 44 inlined `role === "auxiliary"` / `role !== "auxiliary"` predicates fold onto `isAuxiliary()`, `PromiseDescriptor.role` retires its duplicate `"primary"` spelling, the auxiliary wait policy moves to `clients/lsp/auxiliary-lifecycle.ts`, and the `notifyInflightLimit` / `replyOrdering` traits are declared on the server definition. No behaviour change.
