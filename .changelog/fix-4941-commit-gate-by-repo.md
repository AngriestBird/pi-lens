---
section: Fixed
audience: user
---

- **A subagent's commit is no longer refused for a blocker in another repository:** with `--lens-guard` and two sessions in one pi process, the commit gate now judges the blockers inside the repository being committed instead of every blocker the process holds, and its refusal names only that repository's blocker. A commit where the blocker lives, by any session, is still refused, and a command the gate cannot place in a repository (`cd` first, `--git-dir`, an environment prefix, a wrapper) is still judged by every blocker (refs #4941).
