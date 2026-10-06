---
section: Changed
audience: internal
---

- The nightly now opens one draft bot PR (`bot/lsp-idle-evict-promote`) that promotes `idleEviction: "unmeasured"` to `"transparent"` for servers measured eligible on two consecutive runs, with idle RSS of at least 50 MB and a cold start of at most 3 s (#3989).
