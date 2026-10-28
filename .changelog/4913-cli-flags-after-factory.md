---
section: Fixed
audience: user
---

- **`--no-lens` and three sibling command-line flags now take effect (#4913)** — `--no-lens`, `--no-lens-context`, `--lens-compact-tool-line` and `--no-tool <name>` were ignored because pi applies an extension flag's command-line value after the extension has loaded, so pi-lens read the registered default and ignored it. `pi --no-lens` still started language servers and ran the write-time runners; `--no-tool` only worked in the `--no-tool=<name>` spelling. pi-lens now reads these four at `session_start`, so `/lens-toggle` and `/lens-context-toggle` still win for the rest of the session. A tool named by `--no-tool` is dropped from the active set, and `pi_lens_activate_tools` refuses it.
