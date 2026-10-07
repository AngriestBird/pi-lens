---
section: Fixed
audience: internal
---

- The PR-body checker's comment-and-string lexer no longer retains a copy of its output per string literal, cutting `tests/scripts/check-pr-body.test.ts` from a 1.1-2.0 GB peak and 11 s to about 350 MB and 6 s, and the stubbed registry-failure tests no longer echo a real `::error::` annotation into the CI log (#4088).
