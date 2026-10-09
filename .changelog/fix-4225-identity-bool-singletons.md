---
section: Fixed
audience: user
---

- **Identity checks against `True`/`False` are no longer flagged** — the rule now preserves correct Python singleton checks while continuing to catch non-singleton literal comparisons. Thanks @rastarr for the report. (closes [#4225](https://github.com/apmantza/pi-lens/issues/4225))
