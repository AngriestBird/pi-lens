---
section: Changed
audience: user
---

- **Situational tools now start inactive only on models that keep them cheap.** The new default `tools.lazy: "auto"` keeps every pi-lens tool active on a model that folds system messages into one prompt head (where each tool-list change rewrites the cached prompt), and stays lazy on models with `compat.supportsMidConvoSystemMessages`; `true` and `false` keep their meaning. The `ast_grep_*` and `lsp_navigation` schemas are about 1.8 KB smaller: `lang` is a plain string checked at run time (an unknown id is refused with the valid list), `operation` is an enum, and `callHierarchyItem` is validated when used (#4687).
