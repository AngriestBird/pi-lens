---
section: Fixed
audience: user
---

- **Review-graph snapshot keeps emoji whole (refs #3913).** The worker that writes the review graph snapshot split a surrogate pair that straddled a 256 KiB chunk boundary into two replacement characters, so a path or symbol name with an astral character at that spot was stored corrupted.
