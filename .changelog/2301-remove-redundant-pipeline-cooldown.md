---
section: Fixed
---

- **Remove the redundant markdownlint autofix cooldown guard (closes #2301)** — `detectFileChangedAfterCommand` remains the single source of truth for autofix cooldowns, and its direct test owns that contract.
