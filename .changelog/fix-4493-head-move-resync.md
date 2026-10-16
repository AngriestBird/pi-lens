---
section: Fixed
audience: user
---

- **Language servers see a branch switch made with git (refs #4493)** — a clean-tree `git checkout`, `reset --hard`, or completed rebase or cherry-pick left the language server holding the old bytes of every open file, so edits were blocked on errors from the previous branch. pi-lens now notices each move of HEAD, at the bash call that made it or at the next tool call for a move made outside pi. Before that tool returns, it sends the new bytes of the open files the move rewrote to the primary language server, which is the one the next edit is checked against. Auxiliary scanners catch up after the tool returns. A tool call that starts while that send is running waits for it. One `opaque_mutation_head_moved` row records each move.
