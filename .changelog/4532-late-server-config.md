---
section: Fixed
audience: user
---

- **A Python config or stub changed outside pi now reaches the running server (#4532)** — a `pyrightconfig.json` or `pyproject.toml` created, edited or deleted after pyright answered is forwarded to it as a watched-files event at the next look, so an `extraPaths` finding clears on the next read instead of staying stale for the server's life. Python `.pyi` stubs changed outside pi are forwarded like `.d.ts` files. A dependency install into a virtualenv with no lockfile is still not detected.
