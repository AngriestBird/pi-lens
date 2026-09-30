---
section: Fixed
---

- Pin the review graph's structural extraction to the bytes it read, so a concurrent dispatch for the same file can no longer replace `file.content` between the import and function provider reads and make the graph extract imports and functions from two different versions (closes #3552).
