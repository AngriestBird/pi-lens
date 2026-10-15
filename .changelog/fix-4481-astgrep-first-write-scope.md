---
section: Fixed
audience: user
---

- **ast-grep no longer stops on old findings away from an edit (refs #4481)** — on a file's first edit in a session, every existing `severity: error` ast-grep finding became a `🔴 STOP` blocker. Code the edit never touched blocked too. The in-process ast-grep runner and the ast-grep language server now block only on a finding whose lines overlap the edited lines. The tree-sitter rules use the same overlap test instead of the finding's first line. An edit inside a multi-line finding still blocks. A rule that reports a neighbouring node can still be missed on that write, such as the first of two duplicate object keys when the edit adds the second. A whole-file `write` still blocks on every finding. Type errors and linter findings still block on any line, because an edit can cause them at lines it did not touch. Thanks @kwisser for the report.
