---
section: Security
audience: user
---

- **A command lookup no longer starts the project's own files before you trust the project in pi.** Until pi reports the project as trusted, pi-lens leaves out of every child's search path the directories that belong to the session's repository: the session folder, the `node_modules/.bin`, `vendor/bin` and virtualenv bin folders of its parent folders below your home folder, and every checkout of the same git repository, including linked worktrees. pi-lens's own data folder never counts. A command name that would still resolve into the project, for example through a global folder holding a link into it, is refused. The same rule covers `which`/`where` answers, the npm, pnpm and yarn global bin folders (queried from your home folder, so project `.npmrc`-style files cannot redirect them), the installer's PATH check and the LSP launcher. Each refused folder or file is reported once per session as a `trust-refusal` row in `/lens-perf`, with one warning in the extension log. A trusted project, and every MCP host, behaves as before. A session started in your home folder or above it owns nothing (refs #4530).
