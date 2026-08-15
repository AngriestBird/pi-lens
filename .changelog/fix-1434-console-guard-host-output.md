---
section: Fixed
---

- **pi's own CLI output is no longer swallowed by the console guard (Closes #1434)** — The guard used to replace every `console.*` method globally and permanently once the extension loaded. pi's one-shot commands print through `console.log`, so `pi list` exited 0 with no output in any project whose directory loaded the extension first. The guard is now a dispatcher: it routes a write to the extension log only while pi-lens owns execution, and passes every other write to the original console method. Windows open around module evaluation, the extension activation, and each event handler and tool body registered through the host API, and `AsyncLocalStorage` carries the window across `await` boundaries. Terminal safety is unchanged for pi-lens code paths, and `PI_LENS_CONSOLE_GUARD=0` still disables the guard entirely.
