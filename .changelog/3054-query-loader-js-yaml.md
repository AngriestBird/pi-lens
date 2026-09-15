---
section: Changed
---

- **Fold the tree-sitter query loader onto `js-yaml` (refs #3054)** — replace the hand-rolled line-regex YAML scanner in `clients/tree-sitter-query-loader.ts` with `yaml.load`, the same real parser `clients/dispatch/runners/yaml-rule-parser.ts` already uses for ast-grep rules, removing the duplicated inline-array/multi-line-list/nested-object branches that caused #3046's `ignore_paths` quoting bug.
