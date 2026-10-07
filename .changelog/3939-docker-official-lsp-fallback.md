---
section: Changed
audience: user
---

- **The official Docker Language Server is now a built-in fallback (refs #3939)** — when the legacy `docker-langserver` binary is not installed, pi-lens uses the official `docker-language-server start --stdio` if it is on your `PATH`. It is acquired only when the legacy server declines, so the two never publish diagnostics at once; the legacy server still wins when both are present. Denying `docker` in your config therefore promotes the official server, and denying `docker-official` keeps only the legacy one. The official server ships no managed installer entry, so pi-lens never downloads it for you, and its capabilities and idle cost stay unmeasured until evidence exists. Workspace sweeps also no longer skip Dockerfile, Elixir and Python files when only one server of a primary and alternate pair (`docker`/`docker-official`, `elixir`/`expert`, `python`/`python-jedi`) answers: a pair counts as warm when either member answered, and a pair where neither answered is still skipped.
