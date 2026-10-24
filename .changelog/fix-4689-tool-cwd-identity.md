---
section: Fixed
audience: user
---

- **A file reached through a symlink now runs its tools in its own project and keeps one footer row** — a write through `pkg-a/src/blink.ts` (a link to `pkg-b/b.ts`) ran biome and the other root-marker tools in `pkg-a`, with `pkg-a`'s config, while the same file written as `pkg-b/b.ts` ran them in `pkg-b`. The tool's working directory and the project-marker search now start from the file's real location, and the `$HOME` ceiling they stop at is compared on the same footing, so a home directory that is itself a link still stops the climb. Formatting a linked file (`AGENTS.md` linked to `CLAUDE.md`) no longer opens a second footer row under the link's name, and a `lens_diagnostic_mark` call typed with the link's name now retires the real file's row.
