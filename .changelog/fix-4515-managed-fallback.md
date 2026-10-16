---
section: Fixed
audience: user
---

- **Language servers start from the managed install when project trust is unknown (closes #4515)** — on a host that does not report project trust (an older pi, a third-party embedder), the refusal of the project-local `node_modules/.bin` server ended the launch before the managed install was tried, so npm-installed servers (yaml, bash, Docker, Prisma) never started and no diagnostics appeared. The refusal now falls through to the managed install. A refused project binary is never run, not even for a `--version` check. When `PATH` reaches into the project (`npm run`, an activated venv, direnv), only pi-lens's own tool store is read and nothing is installed. Untrusted projects are unchanged: installs stay off there.
