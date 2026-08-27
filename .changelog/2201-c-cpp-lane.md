---
section: Added
---

- **Enable C/C++ memory and I/O idiom rules (refs #2201)** — Add three VTCode-derived rules: `c-no-malloc-free`, `cpp-no-malloc-free`, `cpp-no-printf`. All detection-only, at `severity: warning`, and distinct from CodeRabbit's existing C/C++ security rules.
