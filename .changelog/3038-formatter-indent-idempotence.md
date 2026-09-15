---
section: Fixed
---

- **Make the formatter's no-config indentation fallback stable (refs #3038)** — infer the unit from structural lines only (block-comment interiors are alignment, not nesting), decline ambiguous nested-only evidence, and honor ancestor `.editorconfig` files, so repeated formatting neither amplifies nor shrinks a file's indentation.
