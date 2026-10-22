---
section: Fixed
audience: user
---

- **The commit gate guards `$'git' push` and every other quoting of git commit and git push (#4739)** — `--lens-guard` read the shell's raw token text, so `$'git' push`, `$"git" push`, `g$'i't push`, `git $'push'` and `g\it push` ran unguarded while `git push` was guarded. It now reads the word bash decodes. A word the shell model cannot read (an ANSI-C escape such as `$'\x67it'`, or an expansion such as `$g`) guards the command when it can be git or its verb. An ANSI-C `\'` no longer hides the rest of the command from the gate, and a trailing line continuation no longer drops the last word.
