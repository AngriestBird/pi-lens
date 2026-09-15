---
section: Changed
---

- **Fold the ast-grep catalog source-walk onto one effective-catalog helper (refs #3053)** — The NAPI runner and the LSP-seam rule-ignore matcher now both read `buildEffectiveAstGrepCatalog`, replacing two independent copies of the same source-walk and precedence resolution that had already drifted once (#3046).
