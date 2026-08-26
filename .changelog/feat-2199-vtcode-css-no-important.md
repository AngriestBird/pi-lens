---
section: Added
---

- **Port VTCode's `no-important` CSS rule (closes #2199)** — flags `!important` declarations as a detection-only warning; a safe fix would need to know which selector should win, which the rule cannot infer. Fixing this also closed a real gap: the napi in-process fallback engine (`clients/dispatch/runners/ast-grep-napi.ts`) silently dropped every `language: Css` rule, even though CSS files were already parsed and dispatched to it — the ast-grep LSP was the only path that ever ran a CSS rule. `css` now joins the fallback's supported-language allowlist, so this rule (and any future CSS rule) also fires when the ast-grep binary/LSP is unavailable.
