---
section: Changed
audience: internal
---

- Add a test-only server-selection setter on `clients/lsp/config.ts` (`_setServersForFileForTests`, dropped by `resetLSPConfigStateForTests`, ignored outside a Vitest process) so suites that faked `getServersForFileWithConfig` with a whole-module `vi.mock` inject a per-test server list through the real module instead. The LSP service, diagnostics and runtime-session suites that mocked `clients/lsp/config` move onto it (and onto a pinned HOME for the config loader), deleting their `in-process-mock` baseline rows (#4709).
