---
section: Fixed
audience: user
---

- **Language servers start from the managed install when the project is not trusted (refs #4515)** — on a host that reports project trust as unknown or untrusted, the refusal of the project-local `node_modules/.bin` server ended the launch before the managed install was tried, so npm-installed servers (yaml, bash, Docker, Prisma) never started and no diagnostics appeared. The refusal now falls through to the managed and global candidates; a project-local binary stays refused and is never run.
