---
section: Fixed
---

- **Preserve the active tool set (closes #1453)** — Pi-lens now removes lazy tools only when a new conversation starts. Fork, reload, and resume keep tools that the model activated. Use `--no-lazy-tools` to keep all tools active and prevent tool-list changes.
