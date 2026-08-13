---
section: Added
---

- **Ast-grep dogfood rules for raw JSON store writes and win32 path qualification (refs [#1158](https://github.com/apmantza/pi-lens/issues/1158))** — flag direct JSON store writes and `win32.isAbsolute` qualification calls, with the atomic-write and `isFullyQualified` seams documented as the sanctioned alternatives.
