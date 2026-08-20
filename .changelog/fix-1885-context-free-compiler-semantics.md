---
section: Fixed
---

- **Keep context-free compiler findings non-blocking ([closes #1885](https://github.com/apmantza/pi-lens/issues/1885))** —
  standalone javac, C/C++ syntax checks, Zig single-file builds, and direct
  elixirc runs still report useful compiler errors, but no longer stop an edit
  when missing project classpaths, build flags, modules, or dependencies could
  have caused the finding. A recovered Java LSP clean result also replaces any
  javac findings already held in session diagnostics.
