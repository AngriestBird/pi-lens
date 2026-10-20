---
section: Fixed
audience: user
---

- **An edit in a sibling git worktree of your repository is no longer analysed silently (#2050).** Such an edit already ran the full pipeline — format, autofix, LSP touch and sync, every dispatch runner — but every delivery branch treated it as foreign, so a run that found nothing reached the agent as nothing at all. It now records `tool-result-linked-worktree` once per worktree root per session and, when a run produces no finding, says so in one advisory (`tool-result-linked-worktree-clean`) and stays quiet once the root is known. LSP registration follows the file's class instead of the edited file's directory (#2657): a session file registers its nearest `.pi-lens.json` owner (else the session root), a linked-worktree file registers the worktree root, and an adopted project or an unanalysable path registers nothing — so an adopted project is no longer laundered into a session root, and its cap, idle eviction and project-local-binary refusal apply again.
