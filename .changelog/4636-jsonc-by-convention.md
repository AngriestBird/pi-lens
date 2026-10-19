---
section: Fixed
audience: user
---

- **JSONC-by-convention config files stop reporting comments as blocking errors (closes #4636)** — `tsconfig.json`, `tsconfig.*.json`, `jsconfig.json`, `jsconfig.*.json`, and the `jsonc` basenames VS Code routes the same way (`babel.config.json`, `.babelrc.json`, `.eslintrc.json`, `typedoc.json`) are announced to the JSON language server as `jsonc`, so the comments their format allows are no longer findings. Every other `.json` file still announces `json`, and `effective_config` reports `language: "jsonc"` for the declared names while the file kind stays `json`.
