---
section: Fixed
audience: user
---

- **The commit gate guards `$'git' push` and every other quoting of git commit and git push (#4739)** — `--lens-guard` read the shell's raw token text, so `$'git' push`, `$"git" push`, `g$'i't push`, `git $'push'`, `g\it push` and `(git push)` ran unguarded while `git push` was guarded. It now reads the word bash decodes. ANSI-C words are decoded as bash decodes them (`$'\x67it'` is `git`), so an escape in an ordinary command (`cut -d $'\t'`, `python3 -c $'…'`) no longer trips the gate. A word the shell model cannot read (an expansion such as `$g`) guards the command when it can be git or its verb. Commands inside a subshell or a group are read too, and so is a literal string handed to `eval` (also behind `builtin` or `command`) or to `nix-shell --command`. An escaped launcher switch (`bash $'\x2dc' 'git push'`) is read as the switch it may be. An ANSI-C `\'` no longer hides the rest of the command from the gate, and a trailing line continuation no longer drops the last word.
