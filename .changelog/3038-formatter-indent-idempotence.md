---
section: Fixed
---

- **Make formatter indentation fallback idempotent (refs #3038)** — infer a structurally supported indentation unit, decline ambiguous nested-only evidence, and honor ancestor `.editorconfig` files so repeated formatting cannot amplify indentation.
