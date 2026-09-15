---
section: Fixed
---

- **Make formatter indentation fallback idempotent (refs #3038)** — infer the stable shallowest indentation unit and honor ancestor `.editorconfig` files so repeated formatting cannot amplify indentation.
