---
section: Changed
---

- **A formatter that exits nonzero is now reported as a failure (closes #1337)** — formatter exit-code strictness was opt-in, so any formatter that had not opted in turned every nonzero exit — rejected flags, a crashed binary, an unparseable file — into `{ success: true, changed: false }`, indistinguishable from "already formatted". That default is what let `ruff format` silently no-op for a full release cycle (#1336). The seam is now strict by default, with an audited opt-out (`lenientExitCode`, carrying its evidence) for the four lint-autofix formatters whose exit status reports remaining offenses *after* a successful rewrite: `rubocop -a`, `standardrb --fix`, `ktlint -F`, and `sqlfluff fix`. **Behavior change:** the other 29 formatters now surface an error where they previously reported a silent no-op — most visibly, saving a file with a syntax error reports the formatter's parse error instead of quietly doing nothing.
