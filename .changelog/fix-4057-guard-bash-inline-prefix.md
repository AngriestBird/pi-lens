---
section: Fixed
audience: internal
---

- `guard-bash.mjs` expands the path words of `mktemp` and `node` (a `$TMPDIR` or `~` template, a `-p`/`--tmpdir=` value, a script path) from the shell's own variables, before an inline `VAR=val` prefix applies, as it has done for `git` since #3997. GNU mktemp's own default directory (no template, `-t`, bare `--tmpdir`), which the rule models, and node's `PI_LENS_HOME` still read the prefix (#4057).
