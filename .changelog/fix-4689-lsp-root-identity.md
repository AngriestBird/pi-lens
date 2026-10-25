---
section: Fixed
audience: user
---

- **A file reached through a symlink now gets its own project's language server** — a write through `pkg-a/src/blink.ts` (a link to `pkg-b/b.ts`) started or reused `pkg-a`'s TypeScript server, and a file reached through a linked directory could leave that wrong root cached for the real path too. The language-server root search now starts from the file's real location, for every server, and the directories it refuses or stops at (the home directory, the temp directory's `.git`, the `.pi/agent/extensions` boundary, the session directory) are compared on the same footing, so a session opened through a linked directory keeps one server per package instead of one for the whole session.
