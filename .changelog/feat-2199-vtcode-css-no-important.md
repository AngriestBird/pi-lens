---
section: Added
---

- **Port VTCode's `no-important` CSS rule (closes #2199)** — flags `!important` declarations as a detection-only warning; a safe fix would need to know which selector should win, which the rule cannot infer. CSS and HTML roots are scoped in the napi fallback so language-tagged rules do not scan unrelated parsed roots.
