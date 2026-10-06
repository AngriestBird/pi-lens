---
section: Fixed
audience: user
---

- **Workspace sweeps no longer skip Dockerfile, Elixir and Python files when only one server of a pair works (refs #3939)** — A full workspace diagnostics sweep treated the unused member of a primary and alternate language server pair (`docker` and `docker-official`, `elixir` and `expert`, `python` and `python-jedi`) as a failed warm-up, so every file of that language came back unconfirmed while the working server was healthy. The sweep now counts a pair as warm when either member answered; a pair where neither answered is still skipped.
