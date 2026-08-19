---
section: Fixed
---

- **Basename-classified files (`Makefile`, `Dockerfile.<suffix>`) reached `didOpen` as plaintext, invisible to the #1545 extension-seam guards (refs #1594)** — `clients/file-kinds.ts`'s `SPECIAL_FILENAMES` classifies `Makefile`, `Dockerfile(.<suffix>)?`, and `CMakeLists.txt` by basename regex into `lspCapable` kinds, but `clients/lsp/language.ts`'s `getLanguageId` only resolved language ids through `LANGUAGE_EXTENSIONS`, a flat extension/literal-basename map. `Dockerfile` and `CMakeLists.txt` happened to work because two hand-kept literal keys covered their exact spelling; `Makefile` had no entry at all, and `Dockerfile.dev`/`Dockerfile.prod`-style suffixes never matched the literal `"Dockerfile"` key. `getLanguageId` now falls back to a `BASENAME_LANGUAGE_PATTERNS` list derived from the now-exported `SPECIAL_FILENAMES`, filtered to `lspCapable` kinds — the same single source of truth `detectFileKind` already uses, not a second hand-kept literal list. The two now-redundant literal keys (`"CMakeLists.txt"`, `"Dockerfile"`) were removed from `CURATED_LANGUAGE_EXTENSIONS` since the derivation covers them. `terragrunt.hcl`/`root.hcl` stay unresolved by design: `terragrunt` is `lspCapable: false`.
  - `clients/file-kinds.ts` — `SPECIAL_FILENAMES` exported.
  - `clients/lsp/language.ts` — `getLanguageId`, `BASENAME_LANGUAGE_PATTERNS`.
  - `tests/clients/lsp-capable-seam-coverage.test.ts` — basename-classifier coverage guards mirroring the existing extension-classifier guards 4-6.
