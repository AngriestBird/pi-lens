---
section: Fixed
---

- `lsp_diagnostics` no longer reports "confirmed clean" for an empty result from a language server whose project root fell back (`lsp:server-root-fallback`, for example rust-analyzer on a `.rs` file with no `Cargo.toml`). The verdict is now unconfirmed and names the missing project marker, in single-file, batch and directory output; files whose root resolved normally, and servers that fall back to the file directory by design (gopls, tsserver), keep their clean verdict (closes #3750).
