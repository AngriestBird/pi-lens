---
section: Fixed
---

- **Stop indent-retarget from basing deeper nesting on a template literal's alignment (closes #3116)** — the edit-tool indentation-mismatch autopatch no longer picks its extrapolation base unit from a multi-line template literal's interior line; it now excludes template interiors from that pick with the same lexer `indent-detect.ts` uses (#3059), so a template literal's own alignment ratio can no longer silently mis-scale a deeper-nested replacement, the same way #3052 fixed the analogous block-comment case. A template-interior indent still resolves by direct lookup when a replacement reintroduces it.
