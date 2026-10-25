---
section: Fixed
audience: user
---

- **A file reached through a link spelling gets its own project's verdicts (refs #4689)** — the containment predicate, four upward walks (formatter configs, grammar write dirs, temporary-checkout markers), the project ignore verdict and a runner's dispatch path now climb and key the file's kernel-real path, so `repo/link/../f.ts` and a directory named `..foo` agree with the real spelling instead of reading as another project's file, as never ignored, or as outside the root.
