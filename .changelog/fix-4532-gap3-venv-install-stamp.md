---
section: Fixed
audience: user
---

- **A `pip install` into a project `.venv` that keeps no lockfile now counts as an install**, so pyright's cached `Import "x" could not be resolved` clears on the next `lsp_diagnostics` call instead of lasting for the server's life. The look stamps each `.venv/<lib|Lib>/…/site-packages` directory beside the lockfile and `node_modules` markers (#4532).
