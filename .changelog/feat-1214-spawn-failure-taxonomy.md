---
section: Fixed
---

- **Spawn failures now distinguish missing tools from invalid working directories (closes #1214)** — Auto-install and reinstall paths run only when the executable itself is missing, preventing futile reinstall loops for cwd and permission failures.
