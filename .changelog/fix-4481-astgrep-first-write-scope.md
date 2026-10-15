---
section: Fixed
audience: user
---

- **ast-grep no longer stops on old findings at lines an edit did not change (refs #4481)** — on the first edit to a file in a session, ast-grep reported every existing `severity: error` finding in the file as a `🔴 STOP` blocker, even on lines the edit never touched. Both the in-process ast-grep runner and the ast-grep language server now block only on findings at the lines the edit changed, as the tree-sitter rules already did. A whole-file `write` still blocks on every finding. Type errors and linter findings still block on any line, because an edit can cause them at lines it did not touch. Thanks @kwisser for the report.
