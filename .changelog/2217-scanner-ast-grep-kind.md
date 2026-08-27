---
section: Fixed
---

- **Derive the project scan's ast-grep kind per file instead of hard-coding jsts (closes #2217)** — The scanner passed the literal `"jsts"` to `evaluateAstGrepRules` for every napi-evaluated file, including `.css` and `.html`, so `suppressLinterOverlap` (and any future kind-gated ast-grep policy) evaluated non-JS files under a JS/TS linter-overlap decision. It also diverged from the per-edit dispatch path, which derives kind from `detectFileKind` — the same file could see two different kinds depending on which path evaluated it. The scan now calls `detectFileKind` (the shared `KIND_EXTENSIONS` resolver), matching the dispatch path exactly.
