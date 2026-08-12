---
section: Added
---

- **Helm chart linting (refs #1283, slice A)** — YAML and `.tpl` edits within a chart now run one bounded, canonical-root-deduplicated `helm lint`; warnings remain advisory and chart/template errors block. Rendered-manifest validation remains deferred to slice B.
