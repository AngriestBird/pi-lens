---
section: Fixed
audience: user
---

- **A symlinked file is formatted through its real path instead of failing every turn** — Prettier refuses an explicitly named symlink (its exit 2), so a repo with `AGENTS.md -> CLAUDE.md` reported `deferred format: 0 changed, 1 failed` at the end of every agent turn. `formatFile` and the format service now hand the formatter the file's identity (the real path of its nearest existing ancestor plus the missing tail), so `CLAUDE.md` is formatted and nothing fails. A file whose real path sits outside the session's writable roots is refused and writes nothing, whether it was named through a link or directly. The pipeline already skipped files in another project's root; the new refusal also covers files with no project root, such as vendor paths under `node_modules`, which the pipeline used to hand to a formatter (#4689).
