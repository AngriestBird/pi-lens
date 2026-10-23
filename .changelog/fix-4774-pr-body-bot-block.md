---
section: Fixed
audience: internal
---

- The PR-body check no longer reads a bot's appended block as the author's text. A block (Greptile's, CodeRabbit's, any other) opens with an HTML comment after the last template section, and the body now ends there, so a `(refs #N)` in Greptile's "Last reviewed commit" link no longer reds `## Fold check` (#4774).
