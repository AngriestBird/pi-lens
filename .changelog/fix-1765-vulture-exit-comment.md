---
section: Fixed
---

- **Correct the vulture exit-code comment (closes #1765)** — The comment in `clients/dead-code-client.ts` now states the verified vulture 2.16 exit codes: 0 on a clean run, 3 with findings on stdout when dead code is found, and 1 with an error on stderr for invalid input or parse errors.
