---
section: Fixed
audience: internal
---

- `guard-bash.mjs` expands the path words of `mktemp` and `node` (a `$TMPDIR` or `~` template, a `-p`/`--tmpdir=` value, a script path) from the shell's own variables, before an inline `VAR=val` prefix applies, as it has done for `git` since #3997. GNU mktemp's own default directory (no template, `-t`, bare `--tmpdir`), which the rule models, and node's `PI_LENS_HOME` still read the prefix. A mktemp `-p`/`--tmpdir=` value or template that is empty once expanded, or is made only of references the hook cannot resolve and bash can expand to the empty string (a `$NAME`/`${NAME}` with no known value, `$1`-`$9`, `${N}`, `$@`, `$*`, `$!`, in any concatenation), is also judged as that default directory. A `${NAME:-word}`-style default is still left unresolved (#4057).
