---
section: Changed
audience: user
---

- **The official Docker Language Server is now a built-in fallback (refs #3939)** — when the legacy `docker-langserver` binary is not installed, pi-lens uses the official `docker-language-server start --stdio` if it is on your `PATH`. It is acquired only when the legacy server declines, so the two never publish diagnostics at once; the legacy server still wins when both are present. The official server ships no managed installer entry, so pi-lens never downloads it for you, and its capabilities and idle cost stay unmeasured until evidence exists.
