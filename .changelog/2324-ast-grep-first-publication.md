---
section: Fixed
---

- **ast-grep findings survive a silent auxiliary LSP (closes #2324)** — the napi fallback stays active until the ast-grep LSP completes its first diagnostic publication for the SPECIFIC FILE (not just anywhere on its client), closing the race where a sibling file's publication wrongly satisfied the gate. The fallback and the late-auxiliary delivery lane no longer both fire for the same file: a napi run consumes that file's pending late-auxiliary pair. The remaining narrow case — a server that published once but goes silent on a later touch of the same file — is now a bounded `aux-runner-findings-lost` degradation record instead of a silent drop.
