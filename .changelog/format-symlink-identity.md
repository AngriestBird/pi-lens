---
section: Fixed
audience: user
---

- **A symlinked file is formatted through its real path instead of failing every turn** — Prettier and `biome format` refuse a symlink handed to them explicitly, so a repo with `AGENTS.md -> CLAUDE.md` reported `deferred format: 0 changed, 1 failed` at the end of every agent turn. `formatFile` and the format service now hand the formatter the file's identity (the real path of its nearest existing ancestor plus the missing tail), so `CLAUDE.md` is formatted and nothing fails. A file whose real path sits outside the session's writable roots is refused and writes nothing, whether it was named through a link or directly, so a plain file outside the session root (for example a sibling package of a monorepo session) is no longer formatted (#4689).
