---
section: Fixed
audience: user
---

- **ShellCheck runner respects the file's shell dialect (closes #3968)** — Editing a zsh file no longer produces ShellCheck's dialect-mismatch findings (`SC1071`, false `SC2034`-class errors): the runner now resolves the file's dialect (shebang, `shellcheck shell=` directive, then extension) and skips dialects ShellCheck cannot analyze, disclosing the skip instead of reporting errors built on bash semantics. A shebang'd or directive'd file no longer gets a forced `--shell bash` override; ShellCheck's own detection governs. The runner's self-skip also generalizes from the literal `bash` server id to a capability declaration, so a shell LSP that owns lint (the new builtin `shuck` zsh language server, registered on PATH) takes over shellcheck's lane for the files it covers without demoting anything.