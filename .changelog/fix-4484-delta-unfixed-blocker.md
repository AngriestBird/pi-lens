---
section: Fixed
audience: user
---

- **A second write no longer clears an unfixed blocker (refs #4484)** — When a write left an earlier error in place (it edited another line, or the next turn edited the file again), pi-lens treated "nothing new" as fixed: the write said `✓ clean`, the `--lens-guard` commit gate opened, `lens_diagnostics source=session` and the widget showed no issues, and turn end reported the error as cleared. The error now stays blocking until a check of the file no longer finds it: the write says `🔴 Still unfixed: N blocker(s) reported earlier (L…)` instead of clean, the commit gate stays shut, turn end lists it as unresolved, and the session store and widget keep it. This also holds for linters whose ids are positions (helm-lint), where fixing one error renumbers the next, and for a script run without authorship that leaves the error in place. A write that removes the error still reports it resolved.
