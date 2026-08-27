---
section: Fixed
---

- **Repair escaped-newline flattened PR bodies in body lint (refs #2145)** — a body can arrive with the literal two-character sequence `\n` (or `\r\n`) standing in for a real line break, the sibling of the space-flattening shape #2149 already repairs. `detectEscapedNewlineBody`/`repairEscapedNewlineBody` restore it losslessly, but refuse outright when the body carries a fenced code block: a flattened fence's own delimiters can no longer be told apart from genuine content, so fence-safe repair stays deferred as recorded on the issue.
