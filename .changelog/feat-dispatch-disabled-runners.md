---
section: Added
audience: user
---

- **`dispatch.disabledRunners` turns a dispatch runner off** — list runner ids such as `["dotnet-build"]` in `~/.pi-lens/config.json` or a project `.pi-lens.json` and pi-lens never runs them, so no `dotnet build` (or other tool) is spawned while the language server and every other runner in the group keep working. The list is a denial, resolved like `lsp.disabledServers`: the union of every tier, so a project can add a runner but never re-enable one you denied. A disabled runner is recorded as skipped with the reason `disabled-by-config`, not as a failure, and a fallback group moves on to its next runner. An id that names no runner is dropped with a `PILENS_CFG_0005` warning that quotes it. `effective_config` shows the runner as `disabled-by-config` with the tier and file that denied it. `dispatch.runnerTimeoutFloorMs` stays global-only and a project file that sets it is now told so.
