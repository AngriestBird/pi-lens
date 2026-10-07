---
section: Fixed
audience: user
---

- `lens_diagnostics`/`pilens_diagnostics` with `source: "lsp"` now expands a
  directory in `paths` into its eligible files through the same bounded walk
  the single `path` route already uses, instead of reporting one `failed`
  "not a file" outcome and dropping the whole subtree (fixes #3965).
