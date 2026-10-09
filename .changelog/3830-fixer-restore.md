---
section: Fixed
audience: user
---

- **Report fixer restore loss.** Agent edits that a whole-package fixer erased are now reported when their calls overlap the restore, or when a later edit landed on the fixer's bytes; newer bytes are retained when the restore can prove they are newer. One case stays unreported and is named as a residual: a fixer write that lands between an edit's tool call and the host applying that edit (#3830).
