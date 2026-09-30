---
section: Fixed
---

- **A formatter that writes after the post-exit wait gave up no longer leaves the language server behind the disk (closes #3828)** — #3728 bounded the deferred drain's post-exit resync and, on expiry, never synced again, so a formatter whose command resolution (an auto-install) outlived the bound wrote later and diagnostics, `lsp_diagnostics` and the widget kept reading the pre-format document until the next read or edit of that file. The give-up now chains the same fresh stamped read and session-guarded sync onto the formatter's settlement, a detached continuation that holds no task or resource and does nothing once its session or LSP service was retired; a failure in it records one `hook-handler-crash` row (`deferred-format-late-resync`). `formal/format-drain` gains the give-up and the late resync (`OrphanNoLateSync` and `FixNoLateSync` violate `LspMatchesDisk`) and splits the formatter's start into resolve and enter (#3610, `NoInstallHold`).
