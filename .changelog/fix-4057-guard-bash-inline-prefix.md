---
section: Fixed
audience: internal
---

- `guard-bash.mjs` expands the path words of `mktemp` and `node` (a `$TMPDIR` or `~` template, a `-p`/`--tmpdir=` value, a script path) from the shell's own variables, before an inline `VAR=val` prefix applies, as it has done for `git` since #3997. GNU mktemp's own default directory (no template, `-t`, bare `--tmpdir`), which the rule models, and node's `PI_LENS_HOME` still read the prefix. A typed mktemp word or node file word that still holds a reference the hook cannot resolve (any `$NAME`, `${ … }` form, `$( … )`, positional parameter, backtick span or `~user`) is judged as written and with those references removed, and denies when either reading does; an empty `-p`/`--tmpdir=` value or an empty or unset `TMPDIR` is mktemp's default directory, `/tmp` (#4057).
