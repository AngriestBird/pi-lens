---
section: Fixed
---

- **Knip now runs the project's own knip (refs #1721)** — When a project
  installs knip, the dead-code scan spawns that copy instead of pi-lens's
  managed one. A pinned-stale managed knip previously reported unused exports
  the project's own `npx knip` did not, and acting on those flags deletes live
  code. A project that installs knip also no longer needs pi-lens's managed
  copy at all. Each scan records the binary, its version, and the config it ran
  with in `~/.pi-lens/sessionstart.log`.
