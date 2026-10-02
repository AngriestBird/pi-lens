---
section: Fixed
audience: user
---

- A collect-later runner's blocking finding now gates `git commit` and `git push` under `--lens-guard`, before and after the turn end that delivers it, until a later edit resolves it (#3814). A settled answer whose session has already been replaced no longer gates the next session's commit.
