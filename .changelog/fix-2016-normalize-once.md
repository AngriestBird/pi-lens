---
section: Fixed
---

- **Stop re-canonicalizing already-normalized dispatch paths (refs #2016)** — the dispatch context's `filePath`, `cwd`, and `projectRoot` are normalized once at construction, and seven downstream sites no longer pay a redundant `realpathSync` per dispatch. Scanner ids and the relative baseline key move to the cheap syntactic normalizer, which also fixes a key that resolved against the process working directory on Windows and stayed relative on Linux.
