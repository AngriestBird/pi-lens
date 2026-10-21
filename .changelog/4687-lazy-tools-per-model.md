---
section: Changed
audience: user
---

- **New opt-in `tools.lazy: "auto"` keeps every tool active on folding models; four tool schemas shrink.** The default stays `true` (situational tools start inactive on every model). The new opt-in `"auto"` keeps every pi-lens tool active on a model that folds system messages into one prompt head, where each tool-list change rewrites the cached prompt, and stays lazy on models with `compat.supportsMidConvoSystemMessages`; `false` keeps its meaning. The `ast_grep_*` and `lsp_navigation` schemas are about 1.8 KB smaller: `lang` is a plain string checked at run time (an unknown id or a non-string is refused with the valid list), `operation` is an enum, and `callHierarchyItem` is validated when used (#4687).
